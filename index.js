const http = require("http")
const https = require("https")
const ytdl = require("ytdl-core")
const ytdashgen = require("@freetube/yt-dash-manifest-generator")
const ytsr = require("ytsr")
const ytrend = require("yt-trending-scraper")
const ytch = require('yt-channel-info')
const ytcm = require("@freetube/yt-comment-scraper")
const xml2vtt = require('yt-xml2vtt')
const ytpl = require("ytpl")
const port = process.env.PORT || 8000
const apiBase = process.env.HOST || `http://localhost:${port}`
const devMode = true

const httpsGet = (url) => new Promise((resolve, reject) => {

	const req = https.request(url, res => {

		const dataArr = []

		res.on('data', d => {
			dataArr.push(d.toString())
		});

		res.on('end', () => resolve(dataArr.join()))

		res.on("error", () => reject())
	});

	req.on('error', error => {
		console.error(error);
		reject()
	});

	req.end();
})

function createServer() {
	const server = new http.Server()

	server.listen({
		port: 8000,
		host: "localhost"
	})

	server.on("listening", () => console.log("[index] Server listening on port 8000..."))

	server.on("request", async (req, res) => {
		logger(`[Request]: ${req.url}`)
		const url = URLParser(new URL(req.url, `http://${req.headers.host}`))
		const { isAPIRequest } = url
		const { statusCode, data } = isAPIRequest ? await handleRequest(url) : _404({ error: "The requested resource could not be found." })
		logger(`[Response]: ${statusCode}`)
		res.statusCode = statusCode
		res.setHeader("Content-Type", typeof data === "string" ? "application/json" : "text/plain");
		res.setHeader("Cache-Control", `max-age=300`)
		res.setHeader("Access-Control-Allow-Origin", "*")
		res.end(typeof data === "string" ? data : JSON.stringify(data))
	})
}

async function handleRequest(url) {
	const { type, resource, queries } = url
	if (!type) return _400({ error: "No type provided." })
	try {
		switch (type) {
			case "videos":
				return await handleVideoReq(resource)
				break; // not needed, just return from the function
			case "search": {
				const { q, next } = queries
				return await handleSearchReq(q, next)
			}
			case "trending": {
				const { page = "default", geo: geoLocation } = queries
				const opts = {
					geoLocation,
					parseCreatorOnRise: false,
					page
				}
				return await handleTrendingReq(opts)
			}
			case "channel": {
				const { type, next, sort } = queries
				return await handleChannelReq(resource, type, next, sort)
			}
			case "comments": {
				const { next } = queries
				return await handleCommentsReq(resource, next)
			}
			case "captions": {
				return await handleCaptionsReq(url.href)
			}
			case "playlist": {
				const { next } = queries
				return await handlePlaylistReq(resource, next)
			}
			default:
				console.log("default")
				return _404()
		}
	}
	catch (e) {
		console.error(e)
		return _500()
	}
}

function URLParser(url) {
	const segments = url.pathname.split("/").slice(1)
	const firstSegment = segments[0]
	return {
		isAPIRequest: firstSegment === "api",
		type: segments[1],
		resource: segments[2],
		queries: Object.fromEntries(url.searchParams),
		href: url.href
	}
}

async function handleVideoReq(videoId) {
	if (!videoId) return _400({ error: "No video id provided." })
	if (ytdl.validateID(videoId)) {
		const info = await ytdl.getInfo(videoId)
		let dash = ytdashgen.generate_dash_file_from_formats(info.formats, info.videoDetails.lengthSeconds)
		const { captions } = info.player_response
		delete info.player_response
		delete info.response
		delete info.formats
		const proxy = `${apiBase}/proxy?url=`
		// replaceAll isn't supported everywhere
		dash = dash.replace(/https:\/\//gi, `${proxy}https://`)
		dash = dash.split("</Period>")[0]
		const getCaptions = (captions) => {
			let str = ``
			captions.forEach(caption => {
				str += `<AdaptationSet mimeType="text/vtt" lang="${caption.languageCode}"><Representation id="caption" bandwidth="123"><BaseURL>${apiBase}/api/captions?url=${caption.baseUrl.replace(/&/gi, "&amp;")}</BaseURL></Representation></AdaptationSet>`
			})
			return str
		}
		if (captions) dash = dash + getCaptions(captions.playerCaptionsTracklistRenderer.captionTracks)
		dash = dash + `</Period></MPD>`
		return _200({
			videoId,
			info: { ...info, dash }
		})
	}
	//invalid video ID
	else {
		return _400({
			error: `${videoId} is not a valid YouTube video ID.`
		})
	}
}

async function handleSearchReq(query, next) {
	if (!query && !next) {
		return _400({ error: "Empty search query." })
	}
	const opts = {
		pages: 1
	}
	return _200(await (next ? ytsr.continueReq(JSON.parse(next)) : ytsr(query, opts)))
}

async function handleTrendingReq(opts) {
	const trending = await ytrend.scrape_trending_page(opts)
	// remove duplicates
	const ids = []
	const data = []
	trending.forEach(video => {
		if (!ids.includes(video.videoId)) {
			ids.push(video.videoId)
			data.push(video)
		}
	})
	return _200({ trending: data })
}

async function handleChannelReq(channelId, type, next, sortBy) {
	if (!channelId) return _400({ error: "No channel id provided." })
	const config = {
		channelId,
		channelIdType: 0,
		httpsAgent: null,
		sortBy
	}
	let data;
	switch (type) {
		case "videos":
			data = await (next ? ytch.getChannelVideosMore({ continuation: next }) : ytch.getChannelVideos(config))
			break;
		case "playlists":
			data = await (next ? ytch.getChannelPlaylistsMore({ continuation: next }) : ytch.getChannelPlaylistInfo(config))
			break;
		case "community":
			data = await (next ? ytch.getChannelCommunityPosts({ continuation: next }) : ytch.getChannelCommunityPosts(config))
			break;
		default:
			data = await ytch.getChannelInfo(config)
			break;
	}
	return _200(data)
}

async function handleCommentsReq(videoId, next) {
	const payload = {
		videoId,
		sortByNewest: false,
		continuation: next,
		mustSetCookie: false,
		httpsAgent: null
	}
	return _200(await ytcm.getComments(payload))
}

async function handleCaptionsReq(url) {
	const xmlString = await httpsGet(url.replace(`${apiBase}/api/captions?url=`, ""))
	const vtt = await xml2vtt.Parse(xmlString)
	return _200(vtt)
}

async function handlePlaylistReq(id, next) {
	const opts = {
		pages: 1
	}
	const parser = data => {
		const { continuation, items } = data
		delete data.continuation
		delete data.items
		return {
			continuation,
			info: data,
			items
		}
	}
	if (next) {
		return _200(parser(await ytpl.continueReq(JSON.parse(next))))
	}
	else {
		if (!ytpl.validateID(id)) {
			return _400({ error: `${id} is not a valid playlist ID.` })
		}
		return _200(parser(await ytpl(id, opts)));
	}
}

const _404 = (data) => ({ statusCode: 404, data }) // not found
const _400 = data => ({ statusCode: 400, data }) // bad request
const _500 = () => ({ statusCode: 500, data: { error: "A server error occured." } }) // internal server error
const _200 = data => ({ statusCode: 200, data }) // ok
const logger = (message) => {
	if (devMode) console.log(message)
}

exports.handleRequest = handleRequest
exports.URLParser = URLParser
