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
    const dataStringified = JSON.stringify(data);
    console.log("request data is:", data);
    const req = http.request(setOptions(dataStringified),res => console.log("response got:",res.statusCode));
    req.write(dataStringified);
    req.end();
}

module.exports = (message,intentId,uuid) => {
    ///
    const to = message.getParsedHeader("to");
    const from = message.getParsedHeader("from");
    const ToUriParsed = url.parse(to.uri);
    const FromUriParsed = url.parse(from.uri);
    send( { dialogflow_session_id: uuid, dialogflow_response_id : intentId,
    phone_number : FromUriParsed.auth })
    
}