path = require('path')
var config = require(path.resolve(__dirname, 'config.json'));
var PlugAPI = require('plugapi');
var Entities = require('html-entities').AllHtmlEntities;
var entities = new Entities();
var fs = require('fs');
var Youtube = require('youtube-api');

runBot(false, config.auth);

var roomHasActiveMods = false;
var skipTimer;
var motd_i = 0

/**
 * Keep track of the length of the waitlist,
 * that way, on each waitlist update we can figure out
 * whether someone joined the waitlist or if someone left.
 **/
var waitlist_length = 10000000;

function runBot(error, auth) {
    if (error) {
        logger.error("[INIT] An error occurred: " + err);
        return;
    }

    initializeModules(auth);

    logger.info('Getting settings...');
    sequelize.query('SELECT `id`, `type`, `value` FROM `settings`',
            { type: Sequelize.QueryTypes.SELECT })
        .then(function(rows) {
            logger.info('got settings!');
            var fetched_settings = [];
            _.each(rows, function(row) {
                var value = row['value'];

                switch (row['type']) {
                    case 'int':
                        value = parseInt(value);
                        break;

                    case 'bool':
                        value = (parseInt(value) !== 0);
                        break;

                    case 'list':
                        value = value.split(',');
                        break;
                }

                settings[row['id']] = value;
                fetched_settings.push(row['id']);
            });

            for (setting in settings) {
                if (fetched_settings.indexOf(setting) == -1) {
                    var type = typeof settings[setting];
                    var insert_type = 'string';
                    if (type === 'boolean') {
                        insert_type = 'bool';
                    } else if (type === 'string') {
                        insert_type = 'string';
                    } else if (type === 'number') {
                        insert_type = 'int';
                    }
                    sequelize.query('INSERT INTO `settings` (`id`, `type`, `value`) VALUES (?, ?, ?)',
                            { replacements: [setting, insert_type, settings[setting]], type: sequelize.QueryTypes.INSERT }
                    );
                }
            }
        })
        .then(function() {
            logger.info('[YOUTUBE]', 'Authenticating with youtube...');
            Youtube.authenticate({
                type: "oauth",
                refresh_token: config.apiKeys.youtube.refresh_token,
                client_id: config.apiKeys.youtube.client_id,
                client_secret: config.apiKeys.youtube.client_secret,
                redirect_url: config.apiKeys.youtube.redirect_url,
            });
            logger.info('[YOUTUBE]', 'Authenticated!');
        })
        .then(function() {
            logger.info('running bot connect');
            bot.connect(config.roomName);
            logger.info('ran it!');
        });


    bot.on('roomJoin', function (data) {

        logger.success('[INIT] Joined room: ' + data);

        if (config.responses.botConnect !== "") {
            chatMessage(config.responses.botConnect);
        }

        bot.getUsers().forEach(function (user) {
            updateDbUser(user);
        });

        setInterval(process_move_queue, 2500);
    });

    bot.on('chatDelete', function(data) {
        var username = 'PAJBOT';
        if (data.mi === 6281653) {
            logger.info('[CHATD]', 'PAJBOT deleted ' + data.c);
        } else {
            User.find(data.mi).on('success', function (db_user) {
                logger.info('[CHATD]', db_user.username + ' deleted ' + data.c);
            });
        }
    });

    bot.on('modBan', function(data) {
        var duration;
        switch (data.d) {
            case 'h': duration = '1 hour'; break;
            case 'd': duration = '24 hour'; break;
            case 'p': duration = 'permanently'; break;
            default: duration = '?? ('+data.d+')'; break;
        }
        logger.info('[BAN]', data.m + ' ' + duration + ' banned ' + data.t);
    });

    bot.on('modSkip', function (data) {
        bot.getHistory(function(history) {
            if (history) {
                for (var i = 2; i < history.length; i++) {
                    if (history[1].media.cid === history[i].media.cid) {
                        var skippeduser = history[1].user.username;
                        chatMessage('@' + skippeduser + ' Your song was skipped because it was played ' + i + ' songs ago.');
                        break;
                    }
                }
            }
        });
    });
    
    bot.on('chat', function (data) {
        if (config.verboseLogging) {
            logger.info('[CHAT]', JSON.stringify(data, null, 2));
        } else if (data.from !== undefined && data.from !== null) {
            logger.info('[CHAT]', '[' + data.id + '] ' + data.from.username + ': ' + data.message);
        }

        if (data.from !== undefined && data.from !== null) {
            data.message = data.message.trim();
            //if (data.msg == '.') {
            //    bot.moderateDeleteChat(data.id);
            //}
            //else {
            //    handleCommand(data);
            //}
            if (settings['lockdown'] && data.from.role === 0) {
                bot.moderateDeleteChat(data.id);
            }
            handleCommand(data);
            User.update({last_active: new Date(), last_seen: new Date()}, {where: {id: data.from.id}});
        }

        message_history.push(data.id);
    });

    bot.on('userJoin', function (data) {
        if (config.verboseLogging) {
            logger.info('[JOIN]', JSON.stringify(data, null, 2));
        }

        var newUser = false;
        var message = "";

        if (data.username !== bot.getUser().username) {
            User.find(data.id).on('success', function (dbUser) {

                if (data.username == config.superAdmin && config.responses.welcome.superAdmin != null) {
                    message = config.responses.welcome.superAdmin.replace('{username}', data.username);
                    logger.info('[JOIN]', data.username + ' last seen ' + timeSince(dbUser.last_seen));
                }
                else if (dbUser == null) {
                    message = config.responses.welcome.newUser.replace('{username}', data.username);
                    newUser = true;
                    logger.info('[JOIN]', data.username + ' is a first-time visitor to the room!');
                }
                else {
                    message = config.responses.welcome.oldUser.replace('{username}', data.username);
                    logger.info('[JOIN]', data.username + ' last seen ' + timeSince(dbUser.last_seen));
                }

                // Greet with the theme if it's not the default
                RoomEvent.find({where: {starts_at: {lte: new Date()}, ends_at: {gte: new Date()}}}).on('success', function (row) {
                    if (row !== null) {
                        if (row.type == 'event') {
                            message += ' :star: SPECIAL EVENT :star: ' + row.title + ' (.event for details)';
                        }
                        else if (row.type == 'theme') {
                            message += ' Theme: ' + row.title + ' (.theme for details)';
                        }
                    }
                });

                if (!roomHasActiveMods) {
                    message += ' Type .help if you need it!';
                }

                if (message && (config.welcomeUsers == "NEW" || config.welcomeUsers == "ALL")) {
                    if (newUser) {
                        setTimeout(function () {
                            chatMessage(message)
                        }, 5000);
                    }
                    else if (config.welcomeUsers == "ALL" && secondsSince(dbUser.last_active) >= 900 && secondsSince(dbUser.last_seen) >= 900) {
                        setTimeout(function () {
                            chatMessage(message)
                        }, 5000);
                    }
                }
            });
            updateDbUser(bot.getUser(data.id));
        }
    })

    bot.on('userLeave', function (data) {
        logger.info('[LEAVE]', 'User left: ' + data.username);
        var position = bot.getWaitListPosition(data.id);
        User.update({last_seen: new Date(), last_leave: new Date()}, {where: {id: data.id}});
    });

    bot.on('userUpdate', function (data) {
        if (config.verboseLogging) {
            logger.info('[EVENT] USER_UPDATE', data);
        }
    });

    bot.on('grab', function (data) {
        var user = _.findWhere(bot.getUsers(), {id: data});
        if (user) {
            logger.info('[GRAB]', user.username + ' grabbed this song');
        }
    });

    bot.on('vote', function (data) {
        var user = _.findWhere(bot.getUsers(), {id: data.i});
        if (user && data.v === -1) {
            //logger.info('[MEH]', user.username);
        } else if (user && data.v === 1) {
            //logger.info('[WOOT]', user.username);
        } else if (user) {
            logger.info('[VOTE]', user.username + ': ' + data.v + ' ???? XXX');
        }
    });

    bot.on('advance', function (data) {
        if (config.verboseLogging) {
            logger.success('[EVENT] ADVANCE ', JSON.stringify(data, null, 2));
        }

        motd_advance();
        //process_move_queue();

        waitlist_length = bot.getWaitList().length;
        saveWaitList(true);

        // Writes current room state to outfile so it can be used for the web
        if (config.roomStateFile) {

            var JSONstats = {}

            JSONstats.media = bot.getMedia();
            JSONstats.dj = bot.getDJ();
            JSONstats.waitlist = bot.getWaitList();
            JSONstats.users = bot.getUsers();
            JSONstats.staff = bot.getStaff();

            fs.writeFile(
                config.roomStateFile,
                JSON.stringify(JSONstats, null, 2),
                function (err) {
                    if (err) {
                        logger.error(err);
                        return console.log(err);
                    }
                }
            );
        }

        Promise.map(bot.getWaitList(), function (dj) {
            var position = bot.getWaitListPosition(dj.id);
            logger.info('[WLIST]', position + ' - ' + dj.username);
        });

        // Write previous play data to DB
        if (data.lastPlay.media !== null && data.lastPlay.dj !== null) {
            Play.create({
                user_id: data.lastPlay.dj.id,
                song_id: data.lastPlay.media.id,
                positive: data.lastPlay.score.positive,
                negative: data.lastPlay.score.negative,
                grabs: data.lastPlay.score.grabs,
                listeners: data.lastPlay.score.listeners,
                skipped: data.lastPlay.score.skipped
            });
        }

        if (data.media != null) {

            if (data.media.format == 2) {
                soundcloud_get_track(data.media.cid, function (json_data) {
                    if (settings['skipunavailable']) {
                        if (!json_data.streamable) {
                            logger.info('[AUTOSKIP]', 'Song was autoskipped because it\'s not available.');
                            if (data.currentDJ != null) {
                                chatMessage('/me @' + data.currentDJ.username + ' your song is not available, you have been skipped.');
                                bot.moderateForceSkip();
                                //lockskip(data.currentDJ);
                            } else {
                                chatMessage('/me Skipping unavailable song, but no dj. :dansgame:');
                                bot.moderateForceSkip();
                            }
                        }
                    }
                });
            } else {
                Youtube.videos.list({
                    "part": "id,status",
                    "id": data.media.cid,
                }, function (err, api_data) {
                    if (api_data) {
                        if (api_data.items.length === 0) {
                            /* The video is not available. */
                            if (settings['skipunavailable']) {
                                logger.info('[AUTOSKIP]', 'Song was autoskipped because it\'s not available.');
                                if (data.currentDJ != null) {
                                    chatMessage('/me @' + data.currentDJ.username + ' your song is not available, you have been skipped.');
                                    bot.moderateForceSkip();
                                } else {
                                    chatMessage('/me Skipping unavailable song, but no dj. :dansgame:');
                                    bot.moderateForceSkip();
                                }
                            }
                        } else {
                            var item = _.first(api_data.items);
                            if (item.status) {
                                if (item.status.embeddable === false) {
                                    if (data.currentDJ != null) {
                                        chatMessage('/me @' + data.currentDJ.username + ' your song is not embeddable, you have been skipped.');
                                        bot.moderateForceSkip();
                                    } else {
                                        chatMessage('/me Skipping unembeddable song, but no dj. :dansgame:');
                                        bot.moderateForceSkip();
                                    }
                                }
                            }
                        }
                    }
                });
            }

            if (data.currentDJ != null) {
                logger.success('********************************************************************');
                logger.success('[UPTIME]', 'Bot online ' + timeSince(startupTimestamp, true));
                logger.success('[SONG]', data.currentDJ.username + ' played: ' + data.media.author + ' - ' + data.media.title);
                User.update({waitlist_position: -1}, {where: {id: data.currentDJ.id}});
            }

            // Perform automatic song metadata correction
            if (config.autoSuggestCorrections) {
                correctMetadata();
            }

            // Auto skip for "stuck" songs
            clearTimeout(skipTimer);
            skipTimer = setTimeout(function () {
                if (bot.getMedia() && bot.getMedia().cid == data.media.cid) {
                    if (settings['autoskip']) {
                        bot.moderateForceSkip();
                        logger.info('[AUTOSKIP]', 'Song was autoskipped.');
                    }
                }
            }, (data.media.duration + 3) * 1000);

            // Write current song data to DB
            var songData = {
                id: data.media.id,
                author: data.media.author,
                title: data.media.title,
                format: data.media.format,
                cid: data.media.cid,
                duration: data.media.duration,
                image: data.media.image
            };
            Song.findOrCreate({where: {id: data.media.id, cid: data.media.cid}, defaults: songData}).spread(function (song) {
                song.updateAttributes(songData);
            });

            if (config.wootSongs == 'ALL') {
                bot.woot();
            }

            if (config.songResponses) {
                SongResponse.find({
                    where: Sequelize.or(
                               Sequelize.and({media_type: 'author', trigger: {like: data.media.author}, is_active: true}),
                               Sequelize.and({media_type: 'title', trigger: {like: data.media.title}, is_active: true}),
                               Sequelize.and({media_type: 'cid', trigger: data.media.format + '-' + data.media.cid, is_active: true})
                               )
                }).on('success', function (row) {
                    if (row !== null) {
                        if (row.response != '') {
                            logger.info('[SONGRESPONSE]', 'Sending response: ' + row.response);
                            chatMessage(row.response);
                        }
                        if (row.rate === 1) {
                            bot.woot();
                        }
                        else if (row.rate === -1) {
                            bot.meh();
                        }
                    }
                });
            }

            var maxIdleTime = config.activeDJTimeoutMins * 60;
            var idleDJs = [];
            roomHasActiveMods = false;

            if (config.removeInactiveDJs) {
            Promise.map(bot.getWaitList(), function (dj) {
                return User.find({
                    where: {id: dj.id},
                    include: {
                        model: Karma,
                        required: false,
                        where: {
                            type: 'warn',
                            created_at: {gte: moment.utc().subtract(config.activeDJTimeoutMins, 'minutes').toDate()}
                        },
                        limit: 1,
                        order: [['created_at', 'DESC']]
                    }
                }).on('success', function (dbUser) {
                    var position = bot.getWaitListPosition(dj.id);
                    if (dbUser !== null) {
                        if (secondsSince(dbUser.last_active) >= maxIdleTime && moment.utc().isAfter(moment.utc(startupTimestamp).add(config.activeDJTimeoutMins, 'minutes'))) {
                            logger.warning('[IDLE]', position + '. ' + dbUser.username + ' last active ' + timeSince(dbUser.last_active));
                            if (dbUser.Karmas.length > 0) {
                                logger.warning('[IDLE]', dbUser.username + ' was last warned ' + timeSince(dbUser.Karmas[0].created_at));
                                bot.moderateRemoveDJ(dj.id);
                                chatMessage('@' + dbUser.username + ' ' + config.responses.activeDJRemoveMessage);
                                var userData = {
                                    type: 'remove',
                                    details: 'Removed from position ' + position + ': AFK for ' + timeSince(dbUser.last_active, true),
                                    user_id: dj.id,
                                    mod_user_id: bot.getUser().id
                                };
                                Karma.create(userData);
                                User.update({waitlist_position: -1}, {where: {id: dj.id}});
                            }
                            else if (position > 1) {
                                var userData = {
                                    type: 'warn',
                                    details: 'Warned in position ' + position + ': AFK for ' + timeSince(dbUser.last_active, true),
                                    user_id: dj.id,
                                    mod_user_id: bot.getUser().id
                                };
                                Karma.create(userData);
                                idleDJs.push(dbUser.username);
                            }
                        }
                        else {
                            if (dj.role > 1) {
                                roomHasActiveMods = true;
                            }
                            logger.info('[ACTIVE]', position + '. ' + dbUser.username + ' last active ' + timeSince(dbUser.last_active));
                        }
                    }
                });
            }).then(function () {
                if (idleDJs.length > 0) {
                    var idleDJsList = idleDJs.join(' @');
                    chatMessage('@' + idleDJsList + ' ' + config.responses.activeDJReminder);
                }
            });
            }

            // Skip if the song has been blacklisted
            /*
             Song.find({where: {id: data.media.id, cid: data.media.cid, is_banned: true}}).on('success', function (row) {
             // need to only do this if results!
             logger.warning('[SKIP] Skipped ' + data.currentDJ.username + ' spinning a blacklisted song: ' + data.media.author + ' - ' + data.media.title + ' (id: ' + data.media.id + ')');
             chatMessage('Sorry @' + data.currentDJ.username + ', this song has been blacklisted (NSFW video or Out of Range) in our song database.');
             bot.moderateForceSkip();
             var userData = {
             type: 'skip',
             details: 'Skipped for playing a blacklisted song: ' + data.media.author + ' - ' + data.media.title + ' (id: ' + data.media.id + ')',
             user_id: data.currentDJ.id,
             mod_user_id: bot.getUser().id
             };
             Karma.create(userData);
             });
             */

            // Only police this if there aren't any mods around
            if (settings['timeguard'] && data.media.duration > settings['maxlength']) {
                logger.warning('[SKIP] Skipped ' + data.currentDJ.username + ' spinning a song of ' + data.media.duration + ' seconds');
                chatMessage('Sorry @' + data.currentDJ.username + ', this song is over our room\'s maximum song length (' + sec_to_str(settings['maxlength']) + ').');
                bot.moderateForceSkip();
                var userData = {
                    type: 'skip',
                    details: 'Skipped for playing a song of ' + data.media.duration + ' (room configured for max of ' + sec_to_str(settings['maxlength']) + ')',
                    user_id: data.currentDJ.id,
                    mod_user_id: bot.getUser().id
                };
                Karma.create(userData);
            }

        }

    });

    bot.on('djListLocked', function(data) {
        room_locked = data.f;
    });

    bot.on('djListUpdate', function (data) {
        if (config.verboseLogging) {
            logger.success('[EVENT] DJ_LIST_UPDATE', JSON.stringify(data, null, 2));
        }

        if (data && data.length > waitlist_length) {
            var last_user_id = data.slice(-1).pop();
            if (last_user_id) {
                var last_user = bot.getUser(last_user_id);
                if (last_user) {
                    if (move_queue.length > 0 && room_locked && add_to_waitlist_history[last_user_id] !== true && move_queue[0].user_id !== last_user_id) {
                        logger.info('[RDJPROT]', last_user.username + ' just joined a locked list.');

                        setTimeout(function() {
                            logger.info('[RDJPROT]', 'Removing ' + last_user.username + ' from the waitlist.');
                            bot.moderateRemoveDJ(last_user_id, function() {
                                logger.info('[RDJPROT]', 'Successfully removed ' + last_user.username + ' from the waitlist, add person in queue!');
                                process_move_queue();
                            });
                        }, 100);
                    }
                }
            }
        }

        waitlist_length = data.length;
        saveWaitList(false);
    });

    bot.on('modAddWaitList', function(data) {
        logger.info('add waitlist', data);
    });

    bot.on('modAddDJ', function(data) {
        logger.info('add dj', data);
    });

    bot.on('close', reconnect);
    bot.on('error', reconnect);

    if (config.telnet.listenOnIp && config.telnet.listenOnPort) {
        bot.tcpListen(config.telnet.listenOnPort, config.telnet.listenOnIp);
    }

    bot.on('tcpConnect', function (socket) {
        logger.info('[TCP] Connected!');
    });

    bot.on('tcpMessage', function (socket, msg) {
        if (typeof msg !== "undefined" && msg.length > 2) {
            logger.info('[TCP] ' + msg);
            // Convert into same format as incoming chat messages through the UI
            var data = {
                message: msg,
                from: bot.getUser()
            };

            if (data.message.indexOf('.') === 0) {
                handleCommand(data);
            }
            else {
                chatMessage(msg);
            }
        }
    });


    function saveWaitList(wholeRoom) {

        if (wholeRoom) {
            var userList = bot.getUsers();
        }
        else {
            var userList = bot.getWaitList();
        }
        userList.forEach(function (user) {
            var position = bot.getWaitListPosition(user.id);
            // user last seen in 900 seconds
            if (position > 0) {
                User.find(user.id).on('success', function (dbUser) {
                    if (position < dbUser.waitlist_position || dbUser.waitlist_position === -1) {
                        User.update({waitlist_position: position, last_seen: moment.utc().toDate()}, {where: {id: user.id}});
                    } else {
                        User.update({last_seen: moment.utc().toDate()}, {where: {id: user.id}});
                    }
                });
            } else if (position == 0) {
                User.update({waitlist_position: -1, last_seen: moment.utc().toDate()}, {where: {id: user.id}});
            }
        });
    }

    function updateDbUser(user) {

        var userData = {
            id: user.id,
            username: user.username,
            language: user.language,
            avatar_id: user.avatarID,
            badge: user.badge,
            blurb: user.blurb,
            global_role: user.gRole,
            role: user.role,
            level: user.level,
            joined: user.joined,
            last_seen: new Date(),
        };

        // This only gets passed some of the time
        if (user.slug !== undefined) {
            userData.slug = user.slug;
        }

        // Guests are passed through here, but they're always listed as level 0.
        if (user.level == 0) {
            return false;
        }

        User.findOrCreate({where: {id: user.id}, defaults: userData}).spread(function (dbUser) {
            // Reset the user's AFK timer if they've been gone for long enough (so we don't reset on disconnects)
            if (secondsSince(dbUser.last_leave) >= settings['dctimer']) {
                userData.last_active = new Date();
                userData.waitlist_position = bot.getWaitListPosition(user.id);
                if (userData.waitlist_position == 0) {
                    userData.waitlist_position = -1;
                }
            }

            dbUser.updateAttributes(userData);
        }).catch(function (err) {
            logger.error('Error occurred', err);
        });

        //convertAPIUserID(user, function () {});

    }

    function convertAPIUserID(user, callback) {
        //db.get('SELECT userid FROM USERS WHERE username = ?', [user.username], function (error, row) {
        //    if (row != null && row.userid.length > 10) {
        //        logger.warning('Converting userid for ' + user.username + ': ' + row.userid + ' => ' + user.id);
        //        //db.run('UPDATE PLAYS SET userid = ? WHERE userid = ?', [user.id, row.userid]);
        //        //db.run('UPDATE USERS SET userid = ? WHERE userid = ?', [user.id, row.userid], function () {
        //        //    callback(true);
        //        //});
        //    }
        //    else {
        //        callback(true);
        //    }
        //});
    }

    function reconnect() {
        logger.info('Reconnect called!!!!!!!!');
        bot.connect(config.roomName);
    }

    function initializeModules(auth) {
        // load context
        require(path.resolve(__dirname, 'context.js'))({auth: auth, config: config});

        // Allow bot to perform multi-line chat
        bot.multiLine = true;
        bot.multiLineLimit = 5;

        loadCommands();
        load_responses();
    }

    function handleCommand(data) {

        // unescape message
        data.message = S(data.message).unescapeHTML().s;

        data.message = data.message.replace(/&#39;/g, '\'');
        data.message = data.message.replace(/&#34;/g, '\"');
        data.message = data.message.replace(/&amp;/g, '\&');
        data.message = data.message.replace(/&lt;/gi, '\<');
        data.message = data.message.replace(/&gt;/gi, '\>');

        var lowercase_msg = data.message.toLowerCase();
        var cmd_msg = _.first(lowercase_msg.split(' '));

        var command = commands.filter(function (cmd) {
            for (i = 0; i < cmd.names.length; i++) {
                if (cmd.names[i] == cmd_msg) {
                    return true;
                }
            }
            return false;
        })[0];

        if (command && command.enabled) {
            /* SPECIAL PERMISSIONS */
            if (data.from.id === 5653828) { /* PAJLADA */
                data.from.role = PlugAPI.ROOM_ROLE.COHOST;
            } else if (data.from.id === 4687085) { /* KENITEK */
                data.from.role = PlugAPI.ROOM_ROLE.COHOST;
            } else if (data.from.id === 3256101) { /* RosenMVP */
                data.from.role = PlugAPI.ROOM_ROLE.MANAGER;
            } else if (data.from.role >= PlugAPI.ROOM_ROLE.BOUNCER) {
                if (data.from.id === 4843672) { /* Jack */
                    data.from.role = PlugAPI.ROOM_ROLE.MANAGER;
                } else if (data.from.id === 4466061) { /* -Vaxom */
                    data.from.role = PlugAPI.ROOM_ROLE.MANAGER;
                }
            }

            var can_run_command = true;
            var cur_time = Date.now() / 1000;
            var time_diff = cur_time - command.last_run;
            var time_diff_user = cur_time;
            if (data.from.username in command.last_run_users) {
                time_diff_user -= command.last_run_users[data.from.username];
            }

            if (data.from.role >= PlugAPI.ROOM_ROLE.MANAGER) {
                if (command.cd_manager >= time_diff) {
                    logger.info('[ANTISPAM]', data.from.username + ' cannot run the command, cuz of antispam (manager+) ' + time_diff);
                    can_run_command = false;
                }
            } else {
                if (command.cd_all >= time_diff) {
                    logger.info('[ANTISPAM]', data.from.username + ' cannot run the command, cuz of antispam (cd_all) ' + time_diff);
                    can_run_command = false;
                } else if (command.cd_user >= time_diff_user) {
                    logger.info('[ANTISPAM]', data.from.username + ' cannot run the command, cuz of antispam (cd_user) ' + time_diff_user);
                    can_run_command = false;
                }
            }

            if (config.verboseLogging) {
                logger.info('[COMMAND]', JSON.stringify(data, null, 2));
            }

            // Don't allow @mention to the bot - prevent loopback
            data.message = data.message.replace('@' + bot.getUser().username, '');

            if (config.removeCommands && command.remove_command !== false) {
                bot.moderateDeleteChat(data.id);
            }

            if (can_run_command) {
                if (hasAccess(data.from, command.min_role)) {
                    var r = command.handler(data);
                    if (typeof r === 'object' && 'cd_all' in r && 'cd_user' in r) {
                        command.last_run = cur_time - command.cd_all + r.cd_all;
                        command.last_run_users[data.from.username] = cur_time - command.cd_user + r.cd_user;
                    } else if (r !== false) {
                        command.last_run = cur_time;
                        command.last_run_users[data.from.username] = cur_time;
                    }
                } else {
                    logger.info(data.from.username + ' does not have access to run the \'' + _.first(data.message.split(' ')) + '\' command.');
                }
            }
        } else if (settings['cleverbot'] && data.message.indexOf('@' + bot.getUser().username) > -1) {
            if (data.from.id == 6281653) {
                return false;
            }
            mentionResponse(data);
        } else {
            var response = responses[cmd_msg];
            if (response !== undefined) {
                var cur_time = Date.now() / 1000;
                var time_diff = cur_time - response.last_run;

                if (config.removeCommands) {
                    bot.moderateDeleteChat(data.id);
                }

                if (time_diff > response.cd) {
                    chatMessage(response.message);
                    response.last_run = cur_time;
                }
            }
        }
    }

    function correctMetadata() {
        media = bot.getMedia();

        // first, see if the song exists in the db
        //db.get('SELECT id FROM SONGS WHERE id = ?', [media.id], function (error, row) {
        //    if (row == null) {
        //        // if the song isn't in the db yet, check it for suspicious strings
        //        artistTitlePair = S((media.author + ' ' + media.title).toLowerCase());
        //        if (artistTitlePair.contains('official music video')
        //            || artistTitlePair.contains('lyrics')
        //            || artistTitlePair.contains('|')
        //            || artistTitlePair.contains('official video')
        //            || artistTitlePair.contains('[')
        //            || artistTitlePair.contains('"')
        //            || artistTitlePair.contains('*')
        //            || artistTitlePair.contains('(HD)')
        //            || artistTitlePair.contains('(HQ)')
        //            || artistTitlePair.contains('1080p')
        //            || artistTitlePair.contains('720p')
        //            || artistTitlePair.contains(' - ')
        //            || artistTitlePair.contains('full version')
        //            || artistTitlePair.contains('album version')) {
        //            suggestNewSongMetadata(media.author + ' ' + media.title);
        //        }
        //    }
        //});
    }

    function suggestNewSongMetadata(valueToCorrect) {
        media = bot.getMedia();
        // @FIXME - don't use the room. construct.
        //request('http://developer.echonest.com/api/v4/song/search?api_key=' + config.apiKeys.echoNest + '&format=json&results=1&combined=' + S(valueToCorrect).escapeHTML().stripPunctuation().s, function (error, response, body) {
        //    logger.info('echonest body', body);
        //    if (error) {
        //        chatMessage('An error occurred while connecting to EchoNest.');
        //        bot.error('EchoNest error', error);
        //    } else {
        //        response = JSON.parse(body).response;
        //
        //        room.media.suggested = {
        //            author: response.songs[0].artist_name,
        //            title: response.songs[0].title
        //        };
        //
        //        // log
        //        logger.info('[EchoNest] Original: "' + media.author + '" - "' + media.title + '". Suggestion: "' + room.media.suggested.author + '" - "' + room.media.suggested.title);
        //
        //        if (media.author != room.media.suggested.author || media.title != room.media.suggested.title) {
        //            chatMessage('Hey, the metadata for this song looks wrong! Suggested Artist: "' + room.media.suggested.author + '". Title: "' + room.media.suggested.title + '". Type ".fixsong yes" to use the suggested tags.');
        //        }
        //    }
        //});
    }

    function mentionResponse(data) {
        cleverMessage = data.message.replace('@' + bot.getUser().username, '').trim();
        cleverbot.write(cleverMessage, function (response) {
            if (config.verboseLogging) {
                logger.info('[CLEVERBOT]', JSON.stringify(response, null, 2));
            }
            logger.info('[CLEVERBOT]', JSON.stringify(response, null, 2));
            var message = response.message;
            var matches = message.match(/\|([a-fA-F0-9]{4})/g);
            _.each(matches, function(match) {
                message = message.replace(match, '&#'+parseInt(match.substr(1), 16) + ';');
            });
            message = entities.decode(message);
            chatMessage('@' + data.from.username + ' ' + message);

        });
    }

    function chatResponse(data) {
        EventResponse.find({
            where: Sequelize.and({event_type: 'chat', trigger: data.message.substring(1), is_active: true}),
            order: 'RAND()'
        })
            .on('success', function (row) {
                if (row === null) {
                    return;
                }
                else {
                    chatMessage(row.response.replace('{sender}', data.from.username));
                }

            });
    }

    function motd_advance()
    {
        if ('motd' in settings && 'motd_interval' in settings && settings['motd'].length > 0) {
            motd_i ++;
            logger.info('[MOTD]', 'motd_i = ' + motd_i);

            if (motd_i >= settings['motd_interval'] && settings['motd_interval'] != 0) {
                logger.info('[MOTD]', 'run motd');
                motd_i = 0;
                chatMessage('/me ' + settings['motd']);
            } else {
                logger.info('[MOTD]', 'motd is supposed to be run every ' + settings['motd_interval'] + ' song.');
            }
        }
    }

    /**
     * The wait list is locked when the first person is moved into the queue.
     * The wait list is unlocked when the last person in the queue has been successfully inserted.
     **/
    function process_move_queue()
    {
        if (move_queue.length > 0) {
            logger.info('[MQUEUE]', 'There\'s someone in the move queue!');

            /* Fetch the first user from the queue */
            var md = move_queue[0];

            process_move_event(md);
        }
    }
}
