exports.names = ['english', 'eng'];
exports.hidden = false;
exports.enabled = true;
exports.matchStart = true;
exports.cd_all = 0;
exports.cd_user = 2;
exports.cd_manager = 0;
exports.min_role = PERMISSIONS.BOUNCER;
exports.handler = function (data) {
    var params = _.rest(data.message.split(' '), 1);
    var username = '';
    if (params.length < 1) {
        chatMessage('English please.');
    } else {
        username_uf = params.join(' ').trim();
        username = username_uf.replace('@', '');
        var user = _.findWhere(bot.getUsers(), {username: username});
        if (user) {
            var lang = user.language;
            console.info("Language: '" + lang + "'");
            var ch = '/me @' + username + ' ';
            switch (lang) {
                case 'da': ch += 'Vær venlig at tale engelsk.'; break;
                case 'sv': ch += 'Vänligen tala engelska.'; break;
                case 'de': ch += 'Bitte sprechen Sie Englisch.'; break;
                case 'es': ch += 'Por favor, hable Inglés.'; break;
                case 'fr': ch += 'Parlez anglais, s\'il vous plaît.'; break;
                case 'nl': ch += 'Spreek Engels, alstublieft.'; break;
                case 'pl': ch += 'Proszę mówić po angielsku.'; break;
                case 'pt': ch += 'Por favor, fale Inglês.'; break;
                case 'sk': ch += 'Hovorte po anglicky, prosím.'; break;
                case 'cs': ch += 'Mluvte prosím anglicky.'; break;
                case 'sr': ch += 'Молим Вас, говорите енглески.'; break;
                default:   ch += ' English please.';
            }

            chatMessage(ch);
        } else {
            chatMessage('/me Invalid user specified.');
        }
    }
};
