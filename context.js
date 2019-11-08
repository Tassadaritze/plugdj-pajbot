module.exports = function (options) {
    var PlugAPI = require('plugapi');
    var FixedArray = require("fixed-array");

    Sequelize = require('sequelize');
    Promise = require('bluebird');
    Noise = require('spatial-noise');
    Crypto_rand = require('crypto-rand');

    config = options.config;

    bot = undefined;
    fs = require('fs');

    var Cleverbot = require('cleverbot-node');
    cleverbot = new Cleverbot;

    logLevel = false;

    if (config.db.dialect === 'sqlite') {
        sequelize = new Sequelize(null, null, null, {
            dialect: 'sqlite',
            storage: config.db.sqlite.storage,
            logging: logLevel
        });
    }
    else if (config.db.dialect === 'mysql') {
        sequelize = new Sequelize(config.db.mysql.database, config.db.mysql.username, config.db.mysql.password, {
            dialect: 'mysql',
            host: config.db.mysql.host,
            port: config.db.mysql.port,
            logging: logLevel
        });
    }

    sequelize.authenticate().complete(function (err) {
        if (err) {
            console.error('Unable to connect to the database:', err);
        }
        else {
            console.info('Connected to ' + config.db.dialect + ' database');
        }
    });

    // Build up the models and relations
    var models = ['EventResponse', 'Karma', 'Play', 'RoomEvent', 'Song', 'SongResponse', 'User', 'Setting'];
    models.forEach(function (model) {
        this[model] = sequelize.import(__dirname + '/models/' + model);
    });

    // This is useful so commands that don't import PlugAPI can easily check room role values
    ROOM_ROLE = PlugAPI.ROOM_ROLE;

    PERMISSIONS = PlugAPI.ROOM_ROLE;
    PERMISSIONS.BOUNCER_PLUS = Math.ceil((PlugAPI.ROOM_ROLE.BOUNCER + PlugAPI.ROOM_ROLE.MANAGER) / 2.0);

    responses = []
    settings = {
        'autoskip': false,
        'timeguard': false,
        'motd': 'u wot m8?',
        'motd_interval': 10,
        'dctimer': 20 * 60,
        'maxlength': 300,
        'lockdown': false,
        'cleverbot': false,
        'lockskippos': 3,
        'bouncerplus': false,
        'skipunavailable': true,
        'maxlength_buffer': 10,
    };
    setting_names = {
        'autoskip': 'Autoskip',
        'timeguard': 'Timeguard',
        'motd': 'MotD',
        'motd_interval': 'MotD interval',
        'dctimer': 'DC timer',
        'maxlength': 'Max length',
        'lockdown': 'Lockdown',
        'cleverbot': 'Cleverbot',
        'lockskippos': 'Lock skip position',
        'bouncerplus': 'Bouncer+',
        'skipunavailable': 'Skip unavailable songs',
        'maxlength_buffer': 'Max length buffer',
    };
    message_history = FixedArray(900);
    move_queue = [];
    add_to_waitlist_history = {};
    room_locked = false; /* XXX: Is there a way for us to get the room locked status on connect? */
	permitted = [];

    // @TODO - Is it better to declare these directly in the model?
    Song.hasMany(Play);
    User.hasMany(Karma);
    User.hasMany(Karma, {as: 'ModUser', foreignKey: 'mod_user_id'});
    User.hasMany(Play);
    User.hasMany(RoomEvent, {as: 'ModUser', foreignKey: 'mod_user_id'});

    sequelize.sync()
        .on('success', function () {
        })
        .on('error', function (error) {
        });

    package = require(path.resolve(__dirname, 'package.json'));
    request = require('request');
    _ = require('underscore');
    S = require('string');
    moment = require('moment');
    commands = [];
    uptime = new Date();
    lastRpcMessage = new Date();

    iso_languages = {
        'af': 'Afrikkans',
        'ar': 'Arabic',
        'be': 'Belarusian',
        'bg': 'Bulgarian',
        'ca': 'Catalan',
        'cs': 'Czech',
        'da': 'Danish',
        'de': 'German',
        'el': 'Greek',
        'en': 'English',
        'es': 'Spanish',
        'et': 'Estonian',
        'eu': 'Basque',
        'fa': 'Farsi',
        'fi': 'Finnish',
        'fo': 'Faeroese',
        'fr': 'French',
        'ga': 'Irish',
        'gd': 'Gaelic',
        'hi': 'Hindi',
        'hr': 'Croatian',
        'hu': 'Hungarian',
        'id': 'Indonesian',
        'is': 'Icelandic',
        'it': 'Italian',
        'ja': 'Japanese',
        'ji': 'Yiddish',
        'ko': 'Korean',
        'ku': 'Kurdish',
        'lt': 'Lithuanian',
        'lv': 'Latvian',
        'mk': 'Macedonian',
        'ml': 'Malayalam',
        'ms': 'Malasian',
        'mt': 'Maltese',
        'nl': 'Dutch',
        'nb': 'Norwegian',
        'no': 'Norwegian',
        'pa': 'Punjabi',
        'pl': 'Polish',
        'pt': 'Portuguese',
        'rm': 'Rhaeto-Romanic',
        'ro': 'Romanian',
        'ru': 'Russian',
        'sb': 'Sorbian',
        'sk': 'Slovak',
        'sl': 'Slovenian',
        'sq': 'Albanian',
        'sr': 'Serbian',
        'sv': 'Swedish',
        'th': 'Thai',
        'tn': 'Tswana',
        'tr': 'Turkish',
        'ts': 'Tsonga',
        'uk': 'Ukranian',
        'ur': 'Urdu',
        've': 'Venda',
        'vi': 'Vietnamese',
        'xh': 'Xhosa',
        'zh': 'Chinese',
        'zu': 'Zulu'
    };

    /**
     * Set default time thresholds for moment
     * (round up a little less aggressively)
     */
    moment.relativeTimeThreshold('s', 55);
    moment.relativeTimeThreshold('m', 90);
    moment.relativeTimeThreshold('h', 24);
    moment.relativeTimeThreshold('d', 30);
    moment.relativeTimeThreshold('M', 12);

    startupTimestamp = moment.utc().toDate();

    /**
     * Custom functions accessible to commands
     */
    timeSince = function (timestamp, ago) {
        ago = typeof ago !== 'undefined' ? ago : false;
        var message = moment.utc(timestamp).fromNow(ago);

        if (moment().isAfter(moment.utc(timestamp).add(24, 'hours'))) {
            message += ' (' + moment.utc(timestamp).calendar() + ')';
        }

        return message;
    };

    timeUntil = function (timestamp, prefixMessage) {
        var message = moment.utc(timestamp).fromNow();
        if(prefixMessage !== undefined) {
            return '(' + prefixMessage + ' ' + message + ')';
        }
        else {
            return '(' + message + ')';
        }

    };

    secondsSince = function (timestamp) {
        var now = moment.utc();
        timestamp = moment.utc(timestamp);
        return now.diff(timestamp, 'seconds');
    };

    getActiveDJs = function (maxIdleMins, startPosition, callback) {
        var activeUsers = [];
        if (startPosition === undefined) {
            startPosition = 0;
        }

        Promise.map(_.rest(bot.getDJs(), startPosition), function (dj) {
            return User.find({where: {id: dj.id}}).on('success', function (dbUser) {
                if (dbUser !== null && dbUser.id !== bot.getUser().id) {
                    if (secondsSince(dbUser.last_active) <= (maxIdleMins * 60)) {
                        activeUsers.push(dbUser.id);
                    }
                }
            });
        }).then(function () {
            callback(activeUsers);
        });
    }

    hasAccess = function(user, min_role) {
        if (user.role == PlugAPI.ROOM_ROLE.BOUNCER) {
            return (user.role >= min_role || (min_role == PERMISSIONS.BOUNCER_PLUS && settings['bouncerplus']));
        }

        return user.role >= min_role;
    }

    loadCommands = function() {
        commands.length = 0;
        commands = [];

        // Load commands
        try {
            fs.readdirSync(path.resolve(__dirname, 'commands')).forEach(function (file) {
                var filePath = path.resolve(__dirname, 'commands/' + file);
                if (!filePath.endsWith('.js')) {
                    console.log('Ignoring ' + filePath);
                    return;
                }
                var command = require(filePath);

                var new_names = [];

                _.each(command.names, function(alias) {
                    var first_char = alias.charAt(0);
                    if (first_char !== '.' && first_char !== '!') {
                        new_names.push('.' + alias);
                        new_names.push('!' + alias);
                    } else {
                        new_names.push(alias);
                    }
                });

                command.names = new_names;
                command.last_run = 0;
                command.last_run_users = {};

                if (command.min_role === undefined) {
                    command.min_role = PERMISSIONS.NONE;
                }
                commands.push(command);
            });
        } catch (e) {
            console.error('Unable to load command: ', e);
        }
    }

    sec_to_str = function(sec) {
        var days = Math.floor(sec / 86400);
        var hours = Math.floor(sec / 3600) % 24;
        var minutes = Math.floor(sec / 60) % 60;
        var seconds = sec % 60;

        var str_array = [];

        if (days > 0) { str_array.push(days + ' days'); }
        if (hours > 0) { str_array.push(hours + ' hours'); }
        if (minutes > 0) { str_array.push(minutes + ' minutes'); }
        if (seconds > 0) { str_array.push(seconds + ' seconds'); }

        return _.first(str_array, 2).join(', ');
    }

    move_user = function(user_id, new_position) {
        var md = {'user_id': user_id, 'position': new_position};
        var room_length = bot.getWaitList().length;
        var current_position = bot.getWaitListPosition(md.user_id);
        var in_queue = false;

        console.info('[MQUEUE1]', 'Adding ' + user_id + ' to the move queue, position ' + new_position + '. (' + room_length + ')');

        _.each(move_queue, function(_md) {
            if (_md.user_id === user_id) {
                in_queue = true;
                _md.position = new_position;
            }
        });

        if (in_queue) {
            var user = bot.getUser(user_id);
            console.info('[MQUEUE1]', user.username + ' is in the queue already, changing desired position to ' + new_position + '.');
            chatMessage('/me ' + user.username + ' is already in the queue, changing desired position to ' + new_position + '.');
            return;
        }

        if (current_position !== -1 && current_position !== 0) {
            /* If the user is already in the waitlist,
             * we can perform the operation immediately */
            console.info('[MQUEUE1]', 'Performing move for ' + user_id + ' to ' + new_position + ' immediately.');
            process_move_event(md);
        } else {
            /* Otherwise, add the user to the move queue */
            console.info('[MQUEUE1]', 'Added ' + user_id + ' to the move queue, position ' + new_position + '.');
            move_queue_push(md);
        }
    }

    move_queue_push = function(md) {
        move_queue.push(md);
        var current_position = bot.getWaitListPosition(md.user_id);
        if (current_position !== 0) {
            bot.moderateLockBooth(true);
        }

        var user = bot.getUser(md.user_id);
        var room_length = bot.getWaitList().length;
        var current_position = bot.getWaitListPosition(md.user_id);
        if (user) {
            chatMessage('/me Added ' + user.username + ' to the queue. Queue length: ' + move_queue.length);
        }
    }

    move_queue_remove = function(md) {
        move_queue = _.without(move_queue, md);

        if (move_queue.length == 0) {
            console.info('[MQUEUE]', 'Unlocking booth. (move_queue_remove)');
            bot.moderateLockBooth(false, false, function() {
                console.info('[MQUEUE]', 'Successfully unlocked booth. (move_queue_remove)');
            });
        }
    }

    process_move_event = function(md) {
        var current_position = bot.getWaitListPosition(md.user_id);
        var new_position = md.position;
        var room_length = real_waitlist_length();
        var user = bot.getUser(md.user_id);

        if (!user) {
            chatMessage('/me Removing ' + md.username + ' from movement queue, because he\'s not here.');
            move_queue_remove(md);
            return;
        }

        if (new_position > room_length) {
            new_position = room_length;
        }

        /* We're trying to move the user to the same position, just assume we're done! */
        if (current_position === new_position) {
            console.info('[MQUEUE]', 'Trying to move ' + user.username + ' from ' + current_position + ' to ' + new_position + ', skipping.');
            move_queue_remove(md);
            return false;
        }

        /* If the requested position is -1 we assume
         * the person should be removed from the wait list. */
        if (new_position === -1) {
            console.info('[MQUEUE]', 'Removing ' + user.username + ' from the waitlist.');
            bot.moderateRemoveDJ(md.user_id, function() {
                console.info('[MQUEUE]', 'Successfully removed ' + user.username + ' from the waitlist.');
                User.update({waitlist_position: new_position}, {where: {id: md.user_id}});
                move_queue_remove(md);
            });
            return true;
        }

        if (current_position === 0) {
            console.info('[MQUEUE]', user.username + ' is currently playing...');
            if (move_queue.length > 1) {
                var cur_md = move_queue.shift();
                move_queue.push(cur_md);
            }
        } else if (current_position === -1) {
            if (!room_locked) {
                bot.moderateLockBooth(true);
            }
            /* The user is not in queue, for us to move this person,
             * we need to have a free spot in the wait list. */
            if (room_length !== 50) {
                console.info('[MQUEUE]', 'Adding ' + user.username + ' to the queue. (1)');
                add_to_waitlist_history[user.id] = true;
                bot.moderateAddDJ(md.user_id, function () {
                    add_to_waitlist_history[user.id] = true;
                    setTimeout(function() {
                        add_to_waitlist_history[user.id] = false;
                    }, 1000);
                    console.info('[MQUEUE]', 'Successfully added ' + user.username + ' to the queue! (1)');

                    console.info('[MQUEUE]', 'Moving ' + user.username + ' from ' + current_position + ' to ' + new_position + '. (1)');
                    setTimeout(function() {
                        bot.moderateMoveDJ(md.user_id, new_position, function() {
                            move_queue_remove(md);

                            User.update({waitlist_position: new_position}, {where: {id: md.user_id}});
                            console.info('[MQUEUE]', 'Successfully moved ' + user.username + ' from ' + current_position + ' to ' + new_position + '. (1)');

                            if (move_queue.length == 0) {
                                /* The queue is empty, we can unlock the waitlist! */
                                console.info('[MQUEUE]', 'Unlocking booth. (1)');
                                bot.moderateLockBooth(false, false, function() {
                                    console.info('[MQUEUE]', 'Successfully unlocked booth. (1)');
                                });
                            } else {
                                console.info('[MQUEUE]', 'Move queue is not empty, not unlocking booth. (1)');
                                console.info(move_queue);
                            }
                        });
                    }, 250);
                });
            }
        } else {
            console.info('[MQUEUE]', 'Moving ' + user.username + ' from ' + current_position + ' to ' + new_position + '. (2)');
            bot.moderateMoveDJ(md.user_id, new_position, function() {
                console.info('[MQUEUE]', 'Successfully moved ' + user.username + ' from ' + current_position + ' to ' + new_position + '. (2)');

                move_queue_remove(md);

                User.update({waitlist_position: new_position}, {where: {id: md.user_id}});
            });
        }
    }

    message_out_history = [];
    message_queue = [];

    chatMessage = function(message, timeout, add_to_queue) {
        if (timeout === undefined) {
            timeout = -1;
        }
        if (add_to_queue === undefined) {
            add_to_queue = true;
        }
        if (message_out_history.length < 4) {
            console.info('[MSG]', 'Sending chat message: ' + message);
            bot.sendChat(message, timeout);

            message_out_history.push(1);

            setTimeout(function() {
                message_out_history.shift();
            }, 5000);

            return true;
        } else if (add_to_queue === true) {
            console.info('[MSG]', 'Chat history is full, queueing up ' + message);
            message_queue.push({'message': message, 'timeout': timeout});
        } else {

        }

        return false;
    }

    setInterval(function() {
        if (message_queue.length > 0) {
            console.info('[MSG]', 'There\'s a message in the queue. (' + message_queue.length + ')');
            var msg = message_queue[0];

            if (chatMessage(msg.message, msg.timeout, false) === true) {
                message_queue.shift();
                console.info('[MSG]', 'Sent message from queue! New queue length: ' + message_queue.length);
            }
        }
    }, 250);

    modMessage = function(data, message) {
        chatMessage('/me [@' + data.from.username + '] ' + message);
    }

    setting_value_verbose = function(id) {
        if (id in settings) {
            switch (id) {
                case 'maxlength':
                case 'dctimer':
                    return sec_to_str(setting_value(id));
                    break;

                default:
                    return setting_value(id);
                    break;
            }
        }

        return '?';
    }

    setting_value = function(id) {
        if (id in settings) {
            var type = typeof settings[id];

            switch (type) {
                case 'boolean':
                    if (settings[id]) {
                        return 'enabled';
                    } else {
                        return 'disabled';
                    }
                    break;

                default:
                    return settings[id];
                    //console.error('setting_value is not implemented for ' + type);
                    break;
            }
        }
    }

    set_setting = function(id, value, data) {
        if (id in settings) {
            var old_value = settings[id];
            settings[id] = value;

            var type = typeof settings[id];

            if (type === 'boolean') {
                if (value) {
                    value = '1';
                } else {
                    value = '0';
                }
                if (old_value) {
                    old_value = '1';
                } else {
                    old_value = '0';
                }
            }

            sequelize.query('UPDATE `settings` SET `value`=? WHERE `id`=?',
                    { replacements: [value, id] });

            var userData = {
                type: 'setting_change',
                details: 'Setting ' + id + ' changed from ' + old_value + ' to ' + value + ' by ' + data.from.username,
                user_id: data.from.id,
                mod_user_id: data.from.id
            };
            Karma.create(userData);
        }
    }

    /**
     * This handles all setting changes from user commands.
     *
     * setting_handle('autoskip', data) will be called on .autoskip
     * The function will then read all additional parameters and make sure the
     * setting is properly updated in the database if it is changed.
     **/
    setting_handle = function(id, data) {
        if (id in settings) {
            var params = _.rest(data.message.split(' '), 1);
            var name = id;
            if (id in setting_names) {
                name = setting_names[id];
            }

            var type = typeof settings[id];

            if (params.length < 1) {
                switch (type) {
                    case 'boolean':
                        set_setting(id, !settings[id], data);
                        modMessage(data, name + ' is now ' + setting_value(id) + '.');
                        break;

                    default:
                        modMessage(data, name + ': ' + setting_value(id));
                        break;
                }
            } else {
                var msg = params.join(' ').trim();
                switch (type) {
                    case 'boolean':
                        switch (msg.toLowerCase()) {
                            case 'on':
                            case '1':
                                if (settings[id] === true) {
                                    modMessage(data, name + ' is already ' + setting_value(id) + '.');
                                } else {
                                    set_setting(id, true, data);
                                    modMessage(data, name + ' is now ' + setting_value(id) + '.');
                                }
                                break;

                            case 'off':
                            case '0':
                                if (settings[id] === false) {
                                    modMessage(data, name + ' is already ' + setting_value(id) + '.');
                                } else {
                                    set_setting(id, false, data);
                                    modMessage(data, name + ' is now ' + setting_value(id) + '.');
                                }
                                break;

                            case 'status':
                                modMessage(data, name + ' is currently ' + setting_value(id) + '.');
                                break;

                            default:
                                set_setting(id, !settings[id], data);
                                modMessage(data, name + ' is now ' + setting_value(id) + '.');
                                break;
                        }
                        break;

                    case 'string':
                        if (msg.length > 0) {
                            set_setting(id, msg, data);
                            modMessage(data, name + ' changed to: ' + setting_value(id));
                        }
                        break;

                    case 'number':
                        set_setting(id, parseInt(msg), data);
                        modMessage(data, name + ' changed to: ' + setting_value(id));
                        break;

                    default:
                        console.error('Unhandled type: ' + type);
                        break;
                }
            }
        } else {
            console.error(id + ' is not a valid key in settings.');
        }
    }

    /**
     * Returns false if no username is found.
     * Otherwise, returns the username without the @.
     **/
    get_param_username = function(input) {
        var space_pos = input.indexOf(' ');
        if (space_pos === -1 || input.length == space_pos) {
            return false;
        }

        var username = input.substr(space_pos + 1, input.length);

        if (username.length > 1 && username.indexOf(' ') == 0) {
            username = username.substr(1);
        }

        return username;
    }

    lockskip = function(dj) {
        bot.changeDJCycle(false);
        setTimeout(function() {
            bot.changeDJCycle(true, function() {
                bot.moderateForceSkip(function() {
                    setTimeout(function() {
                        bot.changeDJCycle(false);
                        move_user(dj.id, settings['lockskippos']);
                    }, 500);
                });
            });
        }, 250);
    }

    load_responses = function() {
        responses = {};
        EventResponse.findAll({
            where: {is_active: 1}
        }).on('success', function(rows) {
            if (rows) {
                for (var i=0; i<rows.length; ++i) {
                    var row = rows[i];
                    var response = {
                        cd: row['cd'],
                        last_run: 0,
                        message: row['response']
                    };

                    _.each(row['trigger'].split('|'), function(trigger) {
                        trigger = trigger.trim();

                        if (trigger.length > 0) {
                            responses['.'+trigger] = response;
                            responses['!'+trigger] = response;
                        }
                    });
                }
            }
        });
    }

    swap_users = function(user_1, user_2) {
        if (!user_1 || !user_2) {
            return false;
        }

        var position_1 = bot.getWaitListPosition(user_1.id);
        var position_2 = bot.getWaitListPosition(user_2.id);

        if (position_1 !== -1 || position_2 !== -1) {
            if (position_2 === -1) {
                move_user(user_2.id, position_1);
                setTimeout(function() {
                    move_user(user_1.id, position_2);
                }, 500);
            } else {
                move_user(user_1.id, position_2);
                setTimeout(function() {
                    move_user(user_2.id, position_1);
                }, 500);
            }
        }
    }

    /**
     * Useful for commands that only take one parameter, a username.
     * The CB will only return a non-failure if the user is in the room
     *
     * params is a list of strings (most likely taken from _.rest(input))
     *
     * cb example:
     * function(err, user, db_user) {
     *   lalala
     * }
     **/
    get_user_by_param = function(params, cb) {
        var username_formatted = S(params.join(' ').trim()).chompLeft('@').s;

        User.find({
            where: {username: username_formatted}
        }).on('success', function(db_user) {
            if (db_user) {
                var user = _.findWhere(bot.getUsers(), {id: db_user.id});
                if (user) {
                    cb(false, user, db_user);
                } else {
                    cb('NOT_IN_ROOM', false, db_user);
                }
            } else {
                cb('NO_USER', false, false);
            }
        });
    }

    assist = function(message, advice) {
        var params = _.rest(message.split(' '), 1);

        if (params.length >= 1) {
            get_user_by_param(params, function(err, user, db_user) {
                if (user) {
                    chatMessage('/me @' + user.username + ' ' + advice );
                } else {
                    chatMessage('/me ' + advice);
                }
            });
        } else {
            chatMessage('/me ' + advice);
        }
    }

    get_user = function(username) {
        return User.find({
            where: {username: username}
        }).on('success', function(db_user) {
            return 'cool';
            if (db_user) {
                var user = _.findWhere([{id: 5653828}, {id: 5032149}], {id: db_user.id});
                if (user) {
                    return 'asd';
                    cb(false, user, db_user);
                } else {
                    return 'tfw';
                    cb('NOT_IN_ROOM', false, db_user);
                }
            } else {
                cb('NO_USER', false, false);
            }
        });
    }

    CPARAM = {
        INT: 0,
        FLOAT: 1,
        USERNAME: 2,
        STRING: 3,
    };

    /**
     * Usage:
     * parse_command_params('.test 1.5 5', CPARAM.FLOAT, CPARAM.INT).then(function(data) {
     * });
     *
     * Parameters are parsed right-to-left.
     **/
    parse_command_params = function(message) {
        var input = message.split(' ');
        var command = _.first(input).substr(1);
        var rest = _.rest(input);
        var params = {};
        var promises = [];
        for (var i=arguments.length-1; i>=1; --i) {
            var param_type = arguments[i];
            switch (param_type) {
                case CPARAM.FLOAT:
                    var d = rest.pop();
                    var value = parseFloat(d);
                    console.info(value);
                    if (isNaN(value)) {
                        rest.push(d);
                    } else {
                        params[i-1] = value;
                    }
                    break;

                case CPARAM.INT:
                    var d = rest.pop();
                    var value = parseInt(d);
                    console.info(value);
                    if (isNaN(value)) {
                        rest.push(d);
                    } else {
                        params[i-1] = value;
                    }
                    break;

                case CPARAM.USERNAME:
                    {
                        var reststr = rest.join(' ');
                        var at_pos = reststr.lastIndexOf('@');
                        if (at_pos == -1 && i-1 == 0) {
                            console.info('Fallbacking to getting username without @');
                            at_pos = -1;
                        }
                        var username = reststr.substr(at_pos+1);
                        rest = reststr.substr(0, at_pos).split(' ');

                        var x = function() {
                            var index = i-1;
                            promises.push(get_user(username).on('success', function(db_user) {
                                if (db_user) {
                                    var user = _.findWhere(bot.getUsers(), {id: db_user.id});
                                    if (user) {
                                        params[index] = {user: user, db_user: db_user};
                                    } else {
                                        params[index] = {err: 'NOT_IN_ROOM', db_user: db_user};
                                    }
                                } else {
                                    params[index] = {err: 'INVALID_USER'};
                                }
                            }));
                        }();
                    }
                    break;

                case CPARAM.STRING:
                    params[i-1] = rest.pop();
                    break;
            }
        }

        return Promise.settle(promises).then(function() {
            return {
                command: command,
                params: params
            };
        });
    }

    soundcloud_request = function (url, callback) {
        request(url + '?client_id='+config.apiKeys.soundcloud, function (error, response, body) {
            try {
                var json_data = JSON.parse(body);
                callback(json_data);
            } catch (e) {
                console.error('Error caught while trying to parse soundcloud data: ' + e);
            }
        });
    }

    soundcloud_get_track = function(cid, callback) {
        soundcloud_request('https://api.soundcloud.com/tracks/'+cid+'.json', callback);
    }

    real_waitlist = function() {
        /*
        var users = bot.getUsers();
        var waitlist = [];
        for (var user in users) {
            var wl_pos = bot.getWaitListPosition(users[user].id);
            if (wl_pos > 0) {
                console.info(wl_pos + ' - ' + users[user].username);
                waitlist[wl_pos] = users[user];
            }
        }

        //console.info(waitlist);

        return waitlist;
        */
        return bot.getWaitList();
    }

    real_waitlist_length = function() {
        return real_waitlist().length;
    }
};
