// Локальный запуск: npm start
import { server, lanIP, PORT } from './server.mjs';
server.listen(PORT, () => {
  console.log(`\n  Блеф запущен.\n  Экран ведущего:  http://localhost:${PORT}/host.html\n  Гости в той же Wi-Fi сети: http://${lanIP()}:${PORT}/play.html\n`);
});
