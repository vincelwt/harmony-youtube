const ytdl = require('ytdl-core') 
const api_url = "https://www.googleapis.com/youtube/v3"
const auth_url = "https://www.googleapis.com/oauth2/v4/token"


function youtube_parser(url){
    var regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#\&\?]*).*/;
    var match = url.match(regExp);
    return (match&&match[7].length==11)? match[7] : false;
}

const apiRequest = (method, url, auth, params, callback) => {

	if (!url.includes('https://')) url = api_url+url

	let requestOptions = { url: url, method: method, json: true}

	if (auth) requestOptions.auth = { bearer: settings.youtube.access_token }
	else params.key = settings.clientIds.youtube.key
	

	let urlParameters = Object.keys(params).map((i) => typeof params[i] !== 'object' && !getParameterByName(i, requestOptions.url) ? i+'='+params[i]+'&' : '' ).join('') // transforms to url format everything except objects
	requestOptions.url += (requestOptions.url.includes('?') ? '&' : '?') + urlParameters
	
	if (method !== 'GET') {
		requestOptions.json = params
	}

	request(requestOptions, (err, result, body) => {

		if (body && body.error) callback(body.error, body)
		else callback(err, body)
	})

}

const auth = (code, callback) => {

	request.post({
		url: auth_url, 
		json: true, 
		form: {
			client_id: settings.clientIds.youtube.oauth_id,
			client_secret: settings.clientIds.youtube.oauth_secret,
			grant_type: 'authorization_code',
			redirect_uri: 'http://localhost',
			code: code
		} 
	}, (err, httpres, res) => {
		callback(err, res)
	})

}

const refreshToken = (callback) => {

	request.post({
		url: auth_url, 
		json: true, 
		form: {
			client_id: settings.clientIds.youtube.oauth_id,
			client_secret: settings.clientIds.youtube.oauth_secret,
			grant_type: 'refresh_token',
			redirect_uri: 'http://localhost',
			refresh_token: settings.youtube.refresh_token
		} 
	}, (err, httpres, res) => {
		if (err) return callback(err)

		settings.youtube.access_token = res.access_token
		callback()
	})

}

const convertTrack = rawTrack => {

	let id = rawTrack.id.videoId ? rawTrack.id.videoId : rawTrack.id

	return {
		service: 'youtube',
		title: rawTrack.snippet.title,
		artist: {
			id: rawTrack.snippet.channelId,
			name: rawTrack.snippet.channelTitle
		},
		album: {
			id: '',
			name: ''
		},
		share_url: 'https://youtu.be/'+id,
		id: id,
		duration: rawTrack.contentDetails ? ISO8601ToSeconds(rawTrack.contentDetails.duration)*1000 : null,
		artwork: rawTrack.snippet.thumbnails.default.url // For smaller artworks
	}
}

const extractIdFromUrl = url => {
	let regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/
	let match = url.match(regExp)
	if (match && match[2].length == 11) return match[2]
	else return null
}


class Youtube {

	/**
	* Fetch data
	*
	* @returns {Promise}
	*/
	static fetchData (callback) {

		if (!settings.youtube.access_token) {
			settings.youtube.error = true
			return callback([null, true])
		}

		refreshToken(error => {

			if (error) {
				settings.youtube.error = true;
				return callback([error, true])
			}

			let tempTracks = []

			function moreTracks(nextPageToken) {

				apiRequest('GET', '/videos', true, {myRating: 'like', part: 'snippet,contentDetails', maxResults: 50, pageToken: (nextPageToken || null)}, (err, res) => {

					if (err) return callback(err)

					for (let vid of res.items) 
						if ((settings.youtube.onlyMusicCategory && vid.snippet.categoryId === '10') || !settings.youtube.onlyMusicCategory)
							if (vid.snippet.liveBroadcastContent === 'none') // Disable livestreams
								tempTracks.push(convertTrack(vid))
					
					if (res.nextPageToken) moreTracks(res.nextPageToken)
					else over()

				})
			}

			moreTracks()

			function over() {
				Data.addPlaylist({
					service: 'youtube',
					title: 'Liked',
					id: 'favs',
					icon: 'thumbs-up',
					artwork: '',
					tracks: tempTracks
				})

				callback()
			}
		
			apiRequest('GET', '/playlists', true, {part: 'snippet', mine: 'true', maxResults: 50}, (err, res) => {
				if (err) return callback(err)
				
				for (let pl of res.items) {

					!function outer(pl) {

						let tempTracks = []

						function moreTracks(nextPageToken) {
							apiRequest('GET', '/playlistItems', true, {playlistId: pl.id, part: 'snippet', maxResults: 50, pageToken: (nextPageToken || null)}, (err, res) => {
								if (err) return callback(err)

								let tempIds = []

								for (let vid of res.items)
									tempIds.push(vid.snippet.resourceId.videoId)

								apiRequest('GET', '/videos', false, {id: tempIds.join(','), part: 'snippet,contentDetails'}, (err, result) => {
									if (err) return callback(err)

									for (let vid of result.items)
										tempTracks.push(convertTrack(vid))

									if (res.nextPageToken) moreTracks(res.nextPageToken)
									else over()

								})

							})
						}

						moreTracks()

						function over() {
							Data.addPlaylist({
								service: 'youtube',
								title: pl.snippet.title,
								id: pl.id,
								author: {
									name: pl.snippet.channelTitle,
									id: pl.snippet.channelId
								},
								editable: true,
								canBeDeleted: true,
								artwork: pl.snippet.thumbnails.default.url,
								tracks: tempTracks
							})
						}
					
					}(pl)
				}
			})

		})

	}

	/**
	 * Gets a track's streamable URL from it's youtube URL/id
	 *
	 * @param url {String} The YouTube url (or id) of the track
	 * @param callback {Function} The callback function
	 */
	static getStreamUrlFromVideo(url, callback) {

		if (settings.youtube.noVideo)

			ytdl.getInfo(url, [], (err, info) => {

				if (err) {
					console.error(err)
					return callback(err, null)
				}

				let formats = []

				for (let i of info.formats)
					if (!i.resolution) formats.push(i) // Keep only audio streams
				
				formats.sort((a, b) => { // We sort them by bitrate (pretty close to quality)
					return a.audioBitrate - b.audioBitrate
				})

				if (settings.youtube.lowQuality) {
					return callback(null, formats[0].url)
				} else {
					for (let format of formats)
						if (format.audioBitrate > 100)
							return callback(null, format.url)
				}

				/*if (!settings.youtubeQuality || settings.youtubeQuality === 'normal') {

					for (let format of formats)
						if (format.audioBitrate > 100)
							return callback(null, format.url)

				} else if (settings.youtubeQuality == 'lowest') {

					return callback(null, formats[0].url)

				} else if (settings.youtubeQuality == 'best') {

					return callback(null, formats[formats.length - 1].url)

				}*/

				callback("no stream for this url", null)
			})

		else {
			if (url.includes('youtu')) callback(null, 'youtube:'+extractIdFromUrl(url))//Not an id
			else callback(null, 'youtube:'+url)
		}

	}

	/**
	 * Gets a track's streamable URL, the track doesn't need to be from YouTube
	 *
	 * @param track {Object} The track object
	 * @param callback {Function} The callback function
	 */
	static getStreamUrl(track, callback) {

		if (track.service === 'youtube') {
			this.getStreamUrlFromVideo(track.id, (err, url) => {
				callback(err, url, track.id)
			})
		} else { // Track isn't from youtube, let's try to find the closest match
	
			const duration = track.duration / 1000 // we want it in seconds
			const fullTitle = track.artist.name+' '+track.title

			apiRequest('GET', '/search', false, {q: encodeURIComponent(fullTitle), maxResults: 5, part: 'snippet', type: 'video', safeSearch: 'none'}, (err, res) => {

				if (err || !res.items.length) return callback(err, null, track.id)

				if (settings.youtube.smartAlgorithm) {

					let videoIds = []

					for (let i of res.items) {

						let videoTitle = i.snippet.title
						let comparisonTitle = fullTitle

						if (videoTitle.includes(' - ')) { // We can parse the real track name
							videoTitle = videoTitle.split(' - ')[1]
							comparisonTitle = track.title
						}

						if (similarity(videoTitle, comparisonTitle) > 0.4)
							videoIds.push(i.id.videoId)
					}


					videoIds.slice(0, 3) // Keep only first 3 results
					videoIds = videoIds.join() // Transforms to string

					let durations = []

					apiRequest('GET', '/videos', false, {id: videoIds, part: 'contentDetails'}, (err, res) => {
						if (err) return callback(err, null, track.id)

						for (let t of res.items)
							durations.push({id: t.id, duration_diff: Math.abs(ISO8601ToSeconds(t.contentDetails.duration) - duration)})

						durations.sort((a, b) => { // We sort potential tracks by duration difference with original track
							return a.duration_diff - b.duration_diff
						})

						if (!durations[0]) return callback('No corresponding track found', null, track.id)

						this.getStreamUrlFromVideo(durations[0].id, (err, url) => {
							callback(err, url, track.id)
						})

					})

				} else {
					this.getStreamUrlFromVideo(res.items[0].id.videoId, (err, url) => {
						callback(err, url, track.id)
					})
				}

			})
		}
	}


	static resolveTrack (url, callback) {
		let id = extractIdFromUrl(url)
		if (!id) return callback('invalid youtube URL')

		refreshToken(error => {
			apiRequest('GET', '/videos', false, {id: id, part: 'snippet,contentDetails'}, (err, res) => {
				if (err || error) callback(err || error)
				let track = convertTrack(res.items[0])

				callback(null, track)
			})
		})
	}


	/**
	* Called when user wants to activate the service
	*
	* @param callback {Function} Callback function
	*/
	static login (callback) {

		const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${settings.clientIds.youtube.oauth_id}&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/youtube`;
		oauthLogin(oauthUrl, (code) => {

			if (!code) return callback('stopped')

			auth( code, (err, data) => {

				if (err) return callback(err)

				settings.youtube.access_token = data.access_token
				settings.youtube.refresh_token = data.refresh_token

				callback()
			})

		})

	}

	/**
	* Search
	* @param query {String}: the query of the search
	* @param callback
	*/
	static searchTracks (query, callback) {

		refreshToken(error => {

			apiRequest('GET', '/search', false, {q: encodeURIComponent(query), maxResults: 10, part: 'snippet', type: 'video', videoCategoryId: '10', safeSearch: 'none'}, (err, res) => {

				if (err) return console.error(err)
				let tracks = []

				for (let tr of res.items)
					if (tr) tracks.push(convertTrack(tr))

				callback(tracks, query)

			})
		})
	}


	/**
	* Create a Playlist
	*
	* @param name {String} The name of the playlist to be created
	*/
	static createPlaylist (name, callback) {

		refreshToken(error => {

			apiRequest('POST', '/playlists', true, { part: 'snippet', snippet: {  title: name } }, (err, result) => {

				let playlist = result.snippet

				if (err || error) return callback(err || error)

				callback(null, {
					service: 'youtube',
					editable: true,
					canBeDeleted: true,
					author: {
						name: playlist.channelTitle,
						id: playlist.channelId
					},
					title: playlist.title,
					id: result.id,
					artwork: playlist.thumbnails.default.url,
					tracks: []
				})

			})
		})

	}

	/**
	* Delete a Playlist (unfollowing it is Spotify's way)
	*
	* @param playlist {Object} The object of the playlist to be deleted
	*/
	static deletePlaylist (playlist, callback) {

		refreshToken(error => {
			apiRequest('DELETE', `/playlists`, true, {id: playlist.id}, (err, result) => {

				callback(err || error)

			})
		})

	}


	/**
	* Add a track to a playlist
	*
	* @param tracks {Object} The tracks objects
	* @param playlistId {string} The playlist ID
	*/
	static addToPlaylist (tracks, playlistId, callback) {

		refreshToken(error => {
			if (error) callback(error)

			let i = 0;
			function differedLoop(video_id) { // So we make 1 request/2 secs as YouTube doesn't allow to send multiple ids :(
				add(video_id);

				setTimeout(_ => {
					i++;
					if (i < tracks.length) differedLoop(tracks[i].id);
				}, 2000);
			}

			function add(id) {
				apiRequest('POST', '/playlistItems', true, {
					part: 'snippet',
					snippet: {
						playlistId: playlistId,
						resourceId: {
							kind: "youtube#video",
							videoId: id
						}
					}
				}, (err, res) => {
					if (err) callback(err)
				})
			}

			differedLoop(tracks[0].id)

		})
	}



	/**
	* Remove a track from a playlist
	*
	* @param tracks {Object} The tracks objects
	* @param playlistId {string} The playlist ID
	*/
	/*static removeFromPlaylist (tracks, playlistId, callback) {

	}
	*/


	/**
	* Like a song
	*
	* @param track {Object} The track object
	*/

	static like (track, callback) {
		refreshToken(error => {
			apiRequest('POST', '/videos/rate', true, {id: track.id, rating: 'like'}, (err, res) => {
				callback(error || err)
			})
		})
	}

	/**
	* Unlike a song
	*
	* @param track {Object} The track object
	*/

	static unlike (track, callback) {
		refreshToken(error => {
			apiRequest('POST', '/videos/rate', true, {id: track.id, rating: 'none'}, (err, res) => {
				callback(error || err)
			})
		})
	}

	/*
	* Returns the settings items of this plugin
	*
	*/
	static settingsItems () {
		return 	[
			{
				type: 'activate',
				id: 'active'
			},
			{
				description: 'Playlists: Only get videos with music category',
				type: 'checkbox',
				id: 'onlyMusicCategory'
			},
			{
				description: "Use the old, less power hungry, playing mechanism (maybe a violation of YouTube's TOS)",
				type: 'checkbox',
				id: 'noVideo'
			},
			{
				description: 'Force low quality',
				type: 'checkbox',
				id: 'lowQuality'
			}
		]
	}


}

Youtube.favsPlaylistId = "favs"
Youtube.scrobbling = true
Youtube.settings = {
	active: false,
	quality: 'normal',
	smartAlgorithm: false,
	onlyMusicCategory: true
}

module.exports = Youtube