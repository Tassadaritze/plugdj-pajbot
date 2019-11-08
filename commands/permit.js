exports.names = ['permit'];
exports.hidden = false;
exports.enabled = true;
exports.matchStart = true;
exports.cd_all = 0;
exports.cd_user = 0;
exports.cd_manager = 0;
exports.min_role = PERMISSIONS.BOUNCER_PLUS;
exports.handler = function (data) {
    var params = _.rest(data.message.split(' '), 1);
    if (params.length < 1) {
		chatMessage('/me No user specified.');
        return false;
    } else if (params == 'clear') {
		permitted = [];
		return false;
	}
    username = params.join(' ').trim()
    usernameFormatted = S(username).chompLeft('@').s;

    User.find({
        where: {username: usernameFormatted}
    }).on('success', function (dbUser) {
        if (dbUser) {
			permitted.push(dbUser.id);
			chatMessage('@' + dbUser.username + ' the next song you play is allowed to exceed the current max song length.');
        } else {
            return false;
        }
    });
};
