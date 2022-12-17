import * as http from "http";
import * as https from "https";
const port = process.env.PORT || 8000;
const log = process.env.LOG || false;
import { handleRequest, URLParser } from "./index.js";
const server = http.createServer();
// follow redirects
// chrome issues panel shows error "Ensure preflight responses are valid", because the server doesn't respond to the preflight OPTIONS request, see https://web.dev/cross-origin-resource-sharing/#preflight-requests-for-complex-http-calls
const listener = async (req, res) => {
    logger(`[Request]: ${req.url}`)
    if (req.url?.startsWith("/api")) {
        const url = URLParser(new URL(req.url, `http://${req.headers.host}`));
        const { statusCode, data } = await handleRequest(url);
        logger(`[Response]: ${statusCode}`);
        res.statusCode = statusCode;
        res.setHeader("Content-Type", typeof data === "string" ? "text/plain" : "application/json");
        res.setHeader("Cache-Control", `max-age=300`);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(typeof data === "string" ? data : JSON.stringify(data));
    }
    else if (req.url?.startsWith("/proxy")) {
        const url = (new URL(req.url, `http://${req.headers.host}`));
        const urlToGet = new URLSearchParams(url.search).get("url");
        if (!urlToGet) {
            res.statusCode = 400;
            res.end("Required parameter missing.");
            return;
        }
        const headers = {
            // ideally, all? headers in the original request should be passed to the proxyRequest
            ...req.headers,
            host: ""
            // "range": req.headers.range || "bytes=0-"
        };
        const get = (url) => {
            return new Promise((resolve, reject) => {
                https.request(url, { headers }, response => {
                    resolve(response);
                }).on("error", e => reject()).end();
            });
        };
        let redirects = 0;
        let response = await get(url.search.replace("?url=", ""));
        while (response.headers.location && redirects < 10) {
            response = await get(response.headers.location);
            redirects++;
        }
        res.setHeader("access-control-allow-origin", "*");
        res.writeHead(response.statusCode, response.headers)
        response.pipe(res, { end: true });
    }
    else {
        res.statusCode = 404;
        res.end("Not found.");
    }
};
server.on("request", listener);
server.on("listening", () => console.log(`[proxy] Server listening on port ${port}...`));
server.listen({
    port
});
const logger = (...data) => log && console.log(data);
