// Точка входа для Netlify Server: запускаем сервер игры на порту, который выдаёт Netlify.
import { server } from '../../server.mjs';
server.listen(process.env.PORT || 3000);
