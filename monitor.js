var http = require("http");
process.stdin.resume();

var re = /^\s*(\w+)\s+(.+)$/;

var buffer = '';

var collectedData = {};
var dataAge = {};

function onReceiveProbe(system, json) {
    collectedData[system] = json;
    dataAge[system] = Date.now();
}

process.stdin.on("data", function(data) {
    buffer += data.toString();
    var match = buffer.match(re);
    if(!match)
        return;
    try {
        var system = match[1];
        var json = JSON.parse(match[2]);
        buffer = '';
        onReceiveProbe(system, json);
    } catch(e) {
    }
});

function htmlify(s) {
    return s.replace(/</g, "&lt;").replace(/\t/g, "&nbsp;&nbsp;").replace(/\n/g, "<br/>").replace(/ /g, "&nbsp;");
}

function probeJsonToHtml(results) {
    var html = '<table width="100%">';
    var probes = Object.keys(results).sort();
    probes.forEach(function(probeName) {
        var result = results[probeName];
        html += '<tr><td width="200">' + probeName + '</td><td width="*" style="background-color: '+ (result.err ? "#EA5454" : "#55C149") + '"><code>';
        html += htmlify(result.err || JSON.stringify(result.r, null, 2));
        html += '</code></td></tr>';
    });
    html += '</table>';
    return html;
}

http.createServer(function(req, res) {
    if(req.url === "/json") {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(JSON.stringify(collectedData, null, 2));
        return;
    }

    res.writeHead(200, {'Content-Type': 'text/html'});
    res.write("<html><head><title>C9 monitor</title></head><body>");
    var keys = Object.keys(collectedData).sort();
    keys.forEach(function(key) {
        res.write("<h1>" + key + "</h1>Updated: " + ((Date.now() - dataAge[key])/1000) + "s ago<br/>");
        res.write(probeJsonToHtml(collectedData[key]));
    });
    res.end("</body></html>");
}).listen(4445);