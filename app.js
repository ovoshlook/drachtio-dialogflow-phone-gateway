const Srf = require('drachtio-srf');
const srf = new Srf();
const Mrf = require('drachtio-fsmrf');
const mrf = new Mrf(srf);
const config = require('config');
const logger = require('pino')(config.get('logging'));
const CallSession = require('./lib/call-session');
const sendInfo = require('./lib/actions/sendInfo');

/* connect to the drachtio server */
srf.connect(config.get('drachtio'))
  .on('connect', (err, hp) => logger.info(`connected to sip on ${hp}`))
  .on('error', (err) => logger.info(err, 'Error connecting'));

/* we want to handle incoming invites */
srf.invite((req, res) => {
  const callSession = new CallSession(logger, mrf, req, res);
  let intentsNumber = 0;
  callSession
    .on('intent', (intent) => {
        intentsNumber++;
        console.log(callSession.endpoint);
        if (intentsNumber < 2) sendInfo(req.msg,intent.response_id);
    })
    .on('transcription', (transcript) => logger.debug(transcript, 'received transcription'))
    .on('end_of_utterance', (evt) => logger.debug(evt, 'received end_of_utterance'))
    .on('audio', (evt) => logger.info(`received audio file ${evt.path}`))
    .on('error', (err) => logger.info(err, 'received error'))
    .on('end', () => logger.debug('dialogflow session ended'));
  callSession.exec();
});
