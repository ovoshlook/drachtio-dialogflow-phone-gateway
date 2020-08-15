const http = require('http');
const config = require('config');
const url = require("url")

const setOptions = (data) => {
    return {
        host: config.get('webhook.host'),
        path: config.get('webhook.path'),
        //since we are listening on a custom port, we need to specify it by hand
        port: config.get('webhook.port'),
        //This is what changes the request to a POST request
        method: 'POST',
        headers: {
            Authorization: config.get('webhook.auth'),
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    }
}

const send = (data) => {
    const req = http.request(setOptions(data),res => console.log("response got:",res.statusCode));
    console.log("gonna send",data);
    req.write(JSON.stringify(data));
    req.end();
}

module.exports = (message,intentId) => {
    ///
    const to = message.getParsedHeader("to");
    const from = message.getParsedHeader("from");
    const ToUriParsed = url.parse(to.uri);
    const FromUriParsed = url.parse(from.uri);
    console.log(ToUriParsed.auth,FromUriParsed.auth,intentId);
    send( { dialogflow_session_id : intentId,
    phone_number : FromUriParsed.auth })
    
}