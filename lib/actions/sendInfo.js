const http = require('http');
const config = require('config');
const Url = require("url")

let options = {
    host: config.get('webhook.host'),
    path: config.get('webhook.path'),
    //since we are listening on a custom port, we need to specify it by hand
    port: config.get('webhook.port'),
    //This is what changes the request to a POST request
    method: 'POST',
    headers: {
        Authorization: config.get('webhook.auth')
    }
  };

const send = (data) => {
   
    const req = http.request(options,res => console.log(res));
    req.write(data);
    req.end();
}

module.exports = (message,intent) => {
    ///
    const to = message.getParsedHeader("to");
    const from = message.getParsedHeader("from");
    const ToUriParsed = new Url(to.uri);
    const FromUriParsed = new Url(from.uri);
    //send(data)
    
}