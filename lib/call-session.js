const Emitter = require('events');
const config = require('config');
const fillSound = config.has('typing-sound') ? config.get('typing-sound') : '';
const dfOpts = config.get('dialogflow');
const welcomeEvent = config.has('dialogflow.events.welcome') ? config.get('dialogflow.events.welcome') : '';
const {checkIntentForCallTransfer, checkIntentForDtmfEntry} = require('./utils');
const DigitBuffer = require('./digit-buffer');
const fs = require('fs');
const url = require("url")
let serviceAccountJson;

if (config.has('dialogflow.credentials')) {
  try {
    serviceAccountJson = JSON.stringify(JSON.parse(fs.readFileSync(config.get('dialogflow.credentials'))));
  } catch (err) {
    console.log(err, 'Error reading service account json file');
  }
}

/**
 * Class representing a call that is connected to dialogflow
 * @class
 */
class CallSession extends Emitter {
  constructor(logger, mrf, req, res) {
    /**
     * Create a callSession.
     * @param {Object} logger - pino logger
     * @param {Object} mrf - a media resource framework instance
     * @param {Object} req - the incoming SIP request object
     * @param {Object} res - a SIP response object
     */
    super();

    this.logger = logger;
    this.req = req;
    this.res = res;
    this.mrf = mrf;

    // get configured dialogflow project info
    this.locale = config.get('dialogflow.project');
    this.projectId = config.get('dialogflow.lang');
    this.hotword = config.has('dialogflow.hotword') ? config.get('dialogflow.hotword') : '';
  }

  getCalleeInfo(uri) {
    const uriParsed = url.parse(uri);
    if ( uriParsed.auth.length === 0 ) {
        this.logger.error("Callee ",uriParsed.auth,"wrong format");
        return;
    }
    return  uriParsed.auth;
  }

  /**
   * Execute the callSession:
   *  - connect the incoming call to Freeswitch
   *  - start dialogflow
   *  - add dialogflow event listeners needed to move the dialog forward
   */
  async exec() {
    try {
      // get address of freeswitch (usually running locally, but need not)
      const ms = await this.mrf.connect(config.get('freeswitch'));

      // connect the incoming call to freeswitch
      const {endpoint, dialog} = await ms.connectCaller(this.req, this.res);
      dialog.on('destroy', () => {
        endpoint.destroy().catch((err) => this.logger.info(err, 'Error deleting endpoint'));
        this._clearNoinputTimer();
        this.logger.info('call ended');
      });
      this.logger.info(`call connected, starting dialogflow agent ${dfOpts.project} using lang ${dfOpts.lang}`);

      // add dialogflow event listeners
      endpoint.addCustomEventListener('dialogflow::intent', this._onIntent.bind(this, endpoint, dialog));
      endpoint.addCustomEventListener('dialogflow::transcription', this._onTranscription.bind(this, endpoint));
      endpoint.addCustomEventListener('dialogflow::audio_provided', this._onAudioProvided.bind(this, endpoint, dialog));
      endpoint.addCustomEventListener('dialogflow::end_of_utterance', this._onEndOfUtterance.bind(this));
      endpoint.addCustomEventListener('dialogflow::error', this._onError.bind(this));
      endpoint.on('dtmf', this._onDtmf.bind(this, endpoint));

      // start dialogflow agent on the call -- you should probably have created an initial intent
      // in your dialogflow agent that has a specific event name we send to get the initial audio greeting
      if (serviceAccountJson && serviceAccountJson.length > 0) {
        const res = await endpoint.set('GOOGLE_APPLICATION_CREDENTIALS', serviceAccountJson);
        this.logger.info(`res: ${res}`);
      }
      let calleeInfo = this.getCalleeInfo(this.req.msg.uri);
      if (!calleeInfo) {
          return;
      }

      endpoint.api('dialogflow_start', `${endpoint.uuid} ${dfOpts.project} ${dfOpts.lang} ${welcomeEvent}`);

    } catch (err) {
      this.logger.error(err, 'Error connecting call');
      return;
    }
  }

  /**
   * An intent has been returned.  Since we are using SINGLE_UTTERANCE on the dialogflow side,
   * we may get an empty intent, signified by the lack of a 'response_id' attribute.
   * In such a case, we just start another StreamingIntentDetectionRequest.
   * @param {*} ep -  media server endpoint
   * @param {*} dlg - sip dialog
   * @param {*} evt - event data
   */
  _onIntent(ep, dlg, evt) {
    this.emit('intent', evt);

    if (evt.response_id.length === 0) {
      if (this.noinput) {
        this.logger.info('no input timer fired, reprompting..');
        this.noinput = false;
        ep.api('dialogflow_start', `${ep.uuid} ${dfOpts.project} ${dfOpts.lang} actions_intent_NO_INPUT`);
      }
      else if (this.dtmfEntry) {
        ep.api('dialogflow_start', `${ep.uuid} ${dfOpts.project} ${dfOpts.lang} none ${this.dtmfEntry}`);
        this.dtmfEntry = null;
      }
      else {
        ep.api('dialogflow_start', `${ep.uuid} ${dfOpts.project} ${dfOpts.lang}`);
      }
      return;
    }

    // clear the no-input timer and the digit buffer
    this._clearNoinputTimer();
    if (this.digitBuffer) this.digitBuffer.flush();

    // check for call transfer
    const transferTo = checkIntentForCallTransfer(evt);
    if (transferTo) {
      this.logger.info(`transfering call to ${transferTo} after prompt completes`);
      this.transferTo = transferTo;
    }

    //  if 'end_interaction' is true, end the dialog after playing the final prompt
    //  (or in 1 second if there is no final prompt)
    if (evt.query_result.intent.end_interaction || transferTo) {
      this.hangupAfterPlayDone = !transferTo;
      this.waitingForPlayStart = true;
      setTimeout(() => {if (this.waitingForPlayStart) dlg.destroy();}, 1000);
    }
    else {
      // check for dtmf collection instructions
      const dtmfInstructions = checkIntentForDtmfEntry(evt);
      if (dtmfInstructions) {
        this.digitBuffer = new DigitBuffer(this.logger, dtmfInstructions);
        this.digitBuffer.once('fulfilled', this._onDtmfEntryComplete.bind(this, ep));
      }
    }
  }

  /**
   * A transcription - either interim or final - has been returned.
   * If we are doing barge-in based on hotword detection, check for the hotword or phrase.
   * If we are playing a filler sound, like typing, during the fullfillment phase, start that
   * if this is a final transcript.
   * @param {*} ep  -  media server endpoint
   * @param {*} evt - event data
   */
  _onTranscription(ep, evt) {
    this.emit('transcription', evt);

    // if a final transcription, start a typing sound
    if (fillSound.length > 0 && evt.recognition_result && evt.recognition_result.is_final === true &&
      evt.recognition_result.confidence > 0.8) {
      ep.play(fillSound).catch((err) => this.logger.info(err, 'Error playing typing sound'));
    }

    if (dfOpts.hotword && evt.recognition_result &&
      evt.recognition_result.transcript && this.playInProgress &&
      evt.recognition_result.transcript.toLowerCase().includes(dfOpts.hotword.toLowerCase())) {

      this.logger.info(`spotted hotword ${dfOpts.hotword}, killing audio`);
      this.playInProgress = false;
      ep.api('uuid_break', ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
  }

  /**
   * The caller has just finished speaking.  No action currently taken.
   * @param {*} evt - event data
   */
  _onEndOfUtterance(evt) {
    this.emit('end_of_utterance', evt);
  }

  /**
   * Dialogflow has returned an error of some kind.
   * @param {*} evt - event data
   */
  _onError(evt) {
    this.emit('error', evt);
    this.logger.error(`got error: ${JSON.stringify(evt)}`);
  }

  /**
   * Audio has been received from dialogflow and written to a temporary disk file.
   * Start playing the audio, after killing any filler sound that might be playing.
   * When the audio completes, start the no-input timer.
   * @param {*} ep -  media server endpoint
   * @param {*} dlg - sip dialog
   * @param {*} evt - event data
   */
  async _onAudioProvided(ep, dlg, evt) {
    this.emit('audio', evt);
    this.waitingForPlayStart = false;

    // kill filler audio
    await ep.api('uuid_break', ep.uuid);

    // start a new intent, (we want to continue to listen during the audio playback)
    // _unless_ we are transferring or ending the session
    if (!this.hangupAfterPlayDone && !this.transferTo) {
      ep.api('dialogflow_start', `${ep.uuid} ${dfOpts.project} ${dfOpts.lang}`);
    }

    this.playInProgress = true;
    await ep.play(evt.path);
    this.playInProgress = false;
    if (this.hangupAfterPlayDone) {
      this.logger.info('hanging up since intent was marked end interaction');
      dlg.destroy().catch((err) => {this.logger.info(err, 'error hanging up call');});
      this.emit('end');
    }
    else if (this.transferTo) {
      const doRefer = config.has('callTransfer.method') && config.get('callTransfer.method') === 'REFER';
      const domain = config.has('callTransfer.domain') ? config.get('callTransfer.domain') : this.req.source_address;
      this.logger.info(`transfering call to ${this.transferTo} using ${doRefer ? 'REFER' : 'INVITE'}`);
      if (doRefer) {
        dlg.request({
          method: 'REFER',
          headers: {
            'Refer-To': `<sip:${this.transferTo}@${domain}>`,
            'Referred-By': `<sip:${this.req.callingNumber}@${domain}>`,
            'Contact': '<sip:localhost>'
          }
        });
        dlg.on('notify', (req, res) => {
          res.send(200);
          this.logger.info(`received NOTIFY with ${req.body}`);
          if (req.get('Subscription-State').match(/terminated/)) {
            this.logger.info('hanging up after transfer completes');
            dlg.destroy();
            ep.destroy();
            this.emit('end');
          }
        });
      }
      else {
        const srf = dlg.srf;
        try {
          const auth = config.has('callTransfer.auth') ? config.get('callTransfer.auth') : {};
          let earlyMedia = false;
          const from = `<sip:${this.req.calledNumber}@${domain}>`;
          const dlgB = await srf.createUAC(
            `sip:${this.transferTo}@${domain}`,
            {
              localSdp: dlg.remote.sdp,
              auth,
              headers: {
                'From': from
              }
            },
            {
              cbProvisional: (provisionalRes) => {
                if ([180, 183].includes(provisionalRes.status) && provisionalRes.sdp && !earlyMedia) {
                  earlyMedia = true;
                  dlg.modify(provisionalRes.sdp);
                }
              }
            }
          );
          if (!earlyMedia) {
            earlyMedia = true;
            dlg.modify(dlgB.remote.sdp);
          }
          dlg.removeAllListeners('destroy');
          ep.destroy();
          dlg.other = dlgB;
          dlgB.other = dlg;
          [dlg, dlgB].forEach((d) => {
            d.on('destroy', () => {this.emit('end'); d.other.destroy();});
          });
        }
        catch (err) {
          this.logger.info(`Call transfer outdial failed with ${err.status}`);
        }
      }
    }
    else {
      // every time we finish playing a prompt, start the no-input timer
      this._startNoinputTimer(ep, dlg);
    }
  }

  /**
   * receive a dmtf entry from the caller.
   * If we have active dtmf instructions, collect and process accordingly.
   */
  _onDtmf(ep, evt) {
    if (this.digitBuffer) this.digitBuffer.process(evt.dtmf);
  }

  _onDtmfEntryComplete(ep, dtmfEntry) {
    this.logger.info(`collected dtmf entry: ${dtmfEntry}`);
    this.dtmfEntry = dtmfEntry;
    this.digitBuffer = null;
    // if a final transcription, start a typing sound
    if (fillSound.length > 0) {
      ep.play(fillSound).catch((err) => this.logger.info(err, 'Error playing typing sound'));
    }

    // kill the current dialogflow, which will result in us getting an immediate intent
    ep.api('dialogflow_stop', `${ep.uuid}`)
      .catch((err) => this.logger.info(`dialogflow_stop failed: ${err.message}`));
  }

  /**
   * The user has not provided any input for some time.
   * Set the 'noinput' member to true and kill the current dialogflow.
   * This will result in us re-prompting with an event indicating no input.
   * @param {*} ep
   * @param {*} dlg
   */
  _onNoInput(ep, dlg) {
    this.noinput = true;

    // kill the current dialogflow, which will result in us getting an immediate intent
    ep.api('dialogflow_stop', `${ep.uuid}`)
      .catch((err) => this.logger.info(`dialogflow_stop failed: ${err.message}`));
  }

  /**
   * Stop the no-input timer, if it is running
   */
  _clearNoinputTimer() {
    if (!config.has('dialogflow.noInputTimeout')) return;
    if (this.noinputTimer) {
      clearTimeout(this.noinputTimer);
      this.noinputTimer = null;
    }
  }

  /**
   * Start the no-input timer.  The duration is set in the configuration file.
   * @param {*} ep
   * @param {*} dlg
   */
  _startNoinputTimer(ep, dlg) {
    if (!config.has('dialogflow.noInputTimeout')) return;
    this._clearNoinputTimer();
    this.noinputTimer = setTimeout(this._onNoInput.bind(this, ep, dlg), config.get('dialogflow.noInputTimeout'));
  }
}

module.exports = CallSession;
