exports.names = ['.afk'];
exports.hidden = true;
exports.enabled = true;
exports.matchStart = false;
exports.handler = function(data) {
    if (room.staff[data.fromID] > 1 && config.activeDJTimeoutMins > 0) {

        var maxIdleTime = config.activeDJTimeoutMins * 60;
        var idleDJs = [];

        for (i = 0; i < room.djs.length; i++) {
            var dj = room.djs[i].user;
            db.get("SELECT strftime('%s', 'now')-strftime('%s', lastActive) AS 'secondsSinceLastActive', strftime('%s', lastActive) AS 'lastActive', username FROM USERS WHERE userid = ?", [dj.id] , function (error, row) {
                if (row != null) {
                    if(row.secondsSinceLastActive >= maxIdleTime) {
                        console.log('[IDLE] ' + row.username + ' last active '+ timeSince(row.lastActive) + ' ago');
                        idleDJs.push(row.username + ' (' + timeSince(row.lastActive) + ')');
                    }
                    else {
                        console.log('[ACTIVE] ' + row.username + ' last active '+ timeSince(row.lastActive) + ' ago');
                    }
                }
            });

        }

        if (idleDJs.length > 0) {
            var idleDJsList = idleDJs.join(' @');
            bot.chat('@' + idleDJsList + config.responses.activeDJReminder);
        }
        else {
            bot.chat('Everyone\'s currently active! :thumbsup:');
        }


    }
};