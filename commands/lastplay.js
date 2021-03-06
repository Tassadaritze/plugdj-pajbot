exports.names = ['lastplay', 'lastplayed'];
exports.hidden = false;
exports.enabled = true;
exports.matchStart = true;
exports.cd_all = 5;
exports.cd_user = 10;
exports.cd_manager = 5;
exports.min_role = PERMISSIONS.RDJ;
exports.handler = function (data) {
    var params = _.rest(data.message.split(' '), 1);
    if (params.length < 1) {
        chatMessage('/me usage: .lastplay username');
        return;
    }

    username = params.join(' ');
    usernameFormatted = S(username).chompLeft('@').s;

    User.find({where: {username: usernameFormatted}}).on('success', function (dbUser) {
        if (dbUser === null) {
            modMessage(data, 'Invalid user specified.');
        } else {
            Play.find({
                where: {user_id: dbUser['id']},
                order: 'updated_at DESC',
                limit: 1
            }).on('success', function(dbPlay) {
                if (dbPlay === null) {
                    modMessage(data, usernameFormatted + ' has not played a song in this room.');
                } else {
                    Song.find({where: {id: dbPlay['song_id']}}).on('success', function(dbSong) {
                        if (dbSong === null) {
                            modMessage(data, usernameFormatted + ' has not played a song in this room.');
                        } else {
                            var song_link = null;
                            if (dbSong['format'] == 1) {
                                song_link = 'https://youtu.be/' + dbSong['cid'];
                                modMessage(data, usernameFormatted + ' last played ' + dbSong['author'] + ' - ' + dbSong['title'] + ' (' + song_link + ') ' + moment.utc(dbPlay['updated_at']).calendar() + ' (' + moment.utc(dbPlay['updated_at']).fromNow() + ')');
                            } else {
                                soundcloud_get_track(dbSong['cid'], function (json_data) {
                                    song_link = json_data.permalink_url;
                                    modMessage(data, usernameFormatted + ' last played ' + dbSong['author'] + ' - ' + dbSong['title'] + ' (' + song_link + ') ' + moment.utc(dbPlay['updated_at']).calendar() + ' (' + moment.utc(dbPlay['updated_at']).fromNow() + ')');
                                    });
                            }
                        }
                    });
                }
            });
        }
    });
};
