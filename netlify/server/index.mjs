// Точка входа для Netlify Server: запускаем тот же сервер игры на порту, который выдаёт Netlify.
import game from '../../server.js';
game.server.listen(process.env.PORT || 3000);
