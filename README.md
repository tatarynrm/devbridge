# DevBridge

Десктопний застосунок (Electron), який відкриває локальний сервер для телефона, як ngrok.
Вказуєш порт, отримуєш адресу й QR-код, а всі запити з телефона бачиш у вбудованому інспекторі.

## Запуск

**Готовий .exe:** `dist\DevBridge-1.1.0-portable.exe` — один файл, встановлювати не треба. Перший старт займає кілька секунд, бо файл розпаковується. Підпису немає, тому Windows SmartScreen попередить: «Докладніше» → «Виконати все одно».

**З коду** (Node.js 20+):

```bash
npm install
npm start
```

**Зібрати .exe самому** (на Windows):

```bash
npm run dist:win
```

У `dist\` з'являться інсталятор `DevBridge-Setup-<версія>.exe` (ярлики на робочому столі та в меню «Пуск», деінсталяція) і портативний `DevBridge-<версія>-portable.exe`. На Linux портативна версія збирається без проблем, а для інсталятора потрібен Wine.

**Інсталятор із власним дизайном** (лише на Windows):

```bash
npm run dist:installer
```

З'явиться `dist\DevBridge-Installer-<версія>.exe`. Як він влаштований і як його змінювати: [installer/GUIDE.md](installer/GUIDE.md).

## Збірка для Windows, macOS і Linux (GitHub Actions)

Збірка для macOS можлива лише на macOS (`npm run dist:mac` на Windows завершиться помилкою), тому всі три платформи збирає GitHub: [.github/workflows/build.yml](.github/workflows/build.yml).

| Платформа | Файли |
|---|---|
| Windows x64 | `DevBridge-Installer-<версія>.exe`, `DevBridge-<версія>-portable.exe` |
| macOS | `DevBridge-<версія>-mac-arm64.dmg` (Apple Silicon), `...-mac-x64.dmg` (Intel) |
| Linux x64 | `DevBridge-<версія>-linux-x86_64.AppImage` |

- **push у `main`** або pull request: тести й збірка. Файли лежать у **Actions → потрібний запуск → Artifacts**, кожен завантажується окремо, без ZIP, і зберігається 7 днів.
- **Кнопка Run workflow** на вкладці Actions: збірка вручну.
- **Тег `v…`**: додатково створюється сторінка в **Releases** з усіма файлами.

**Нова версія.** Команда нижче змінює версію в `package.json`, робить коміт і тег (усі зміни перед цим мають бути закомічені):

```bash
npm version patch
git push --follow-tags
```

**Перший запуск на чужому комп'ютері.** Файли не підписані сертифікатом розробника:

- **Windows:** SmartScreen → «Докладніше» → «Виконати все одно».
- **macOS:** після першої спроби запуску відкрий «Системні параметри → Приватність і безпека» → «Все одно відкрити». Якщо macOS пише, що програма пошкоджена: `xattr -cr /Applications/DevBridge.app`.
- **Linux:** `chmod +x DevBridge-*.AppImage`. На частині дистрибутивів потрібен пакет `libfuse2`.

**Ліміти.** Для публічних репозиторіїв стандартні runners безкоштовні. У приватного є місячний ліміт хвилин (хвилини macOS рахуються набагато дорожче) і місця для artifacts, а одна збірка DevBridge займає кількасот мегабайтів. Якщо ліміту не вистачає, прибери `branches: [main]` і залиш збірку лише за тегами та кнопкою. Актуальні цифри дивись у GitHub → Settings → Billing.

## Три способи доступу

| Спосіб | Адреса | Коли брати |
|---|---|---|
| **Cloudflare** | `https://xxx.trycloudflare.com`, нова при кожному запуску | Швидко перевірити: без акаунта й налаштувань. `cloudflared` завантажиться сам. |
| **Свій сервер** | `https://myapi.t.example.com`, постійна | Щоденна розробка: адресу можна прописати в `.env` мобільного додатка. Потрібен relay на VPS (див. нижче). |
| **Локальна мережа** | `http://192.168.x.x:8100` | Телефон у тій самій Wi-Fi, інтернет не потрібен. Лише http. |

## Що вміє

- Пропускає HTTP, WebSocket (HMR у Metro/Vite), SSE і великі файли без змін.
- **Інспектор запитів:** метод, шлях, статус, час, заголовки й тіло. gzip/br розпаковуються, JSON форматується, картинки показуються.
- **Повтор запиту** і **копіювання як cURL**.
- Індикатор, чи живий локальний сервер. Якщо він лежить, телефон отримує зрозумілий 502 (JSON для `Accept: application/json`).
- QR-код для телефона, готові рядки `EXPO_PUBLIC_API_URL=…` і `EXPO_PACKAGER_PROXY_URL=…`.
- Опція **«Підміняти Host»** для Vite/Angular, які відхиляють чужий Host.
- Автозапуск тунелів, постійний порт для LAN, токен сервера зберігається зашифрованим (safeStorage).

## Налаштування

| Розділ | Що можна змінити |
|---|---|
| Вигляд | Тема (як у системі, темна, світла), акцентний колір (5 варіантів), компактний журнал |
| Застосунок | Згортання в трей при закритті, запуск разом із Windows (з одразу згорнутим вікном), сповіщення про онлайн/помилку, автокопіювання адреси |
| Свій сервер | Адреса й токен relay, перевірка з'єднання |
| Cloudflare | Встановлення/оновлення cloudflared, протокол (авто, HTTP/2, QUIC) |
| Інспектор | Скільки запитів зберігати (100–5000) і скільки тіла записувати (0–20 МБ) |

**Трей:** з іконки можна запускати й зупиняти тунелі, копіювати адреси й виходити з програми. Якщо ввімкнено «Згортати в трей», закриття вікна не зупиняє тунелі.

## Expo / React Native

**API (NestJS тощо) через тунель:**

```bash
# .env мобільного додатка
EXPO_PUBLIC_API_URL=https://myapi.t.example.com
```

**Metro через тунель** (телефон не в тій самій мережі): створи тунель на порт `8081` і запусти

```bash
# PowerShell
$env:EXPO_PACKAGER_PROXY_URL="https://metro.t.example.com"; npx expo start
```

Для LAN (http) у release-збірках Android/iOS може знадобитися дозвіл на cleartext-трафік. Найпростіше брати Cloudflare або свій сервер з HTTPS.

## Власний сервер (relay на VPS)

Код у папці `server/`. Вибери базовий домен, наприклад `t.example.com`.

**DNS:** два A-записи на IP VPS: `t.example.com` і `*.t.example.com`.

### Варіант A: чистий VPS, Docker + Caddy (HTTPS автоматично)

```bash
# на VPS скопіюй папки server/ і shared/ (або весь репозиторій)
cd server
cp .env.example .env
nano .env            # BASE_DOMAIN, TOKEN (openssl rand -hex 24), ACME_EMAIL
docker compose up -d
```

Caddy отримує сертифікат для кожного субдомену при першому запиті, але лише для тих, які зареєстрував relay. Сторонні домени він відхиляє.

### Варіант B: на VPS уже є nginx

1. Wildcard-сертифікат через DNS-challenge (`certbot ... -d t.example.com -d '*.t.example.com'`).
2. Конфіг: `server/nginx.conf.example`.
3. Relay як сервіс: `server/devbridge-relay.service` (слухає `127.0.0.1:7000`).

### Підключення в застосунку

**Налаштування → Свій сервер:** адреса `https://t.example.com` і токен, потім кнопка **«Перевірити з'єднання»**. Після цього в новому тунелі обирай «Свій сервер» і вкажи субдомен.

Змінні relay: `BASE_DOMAIN`, `TOKEN` (кілька через кому), `PORT` (7000), `HOST`, `PUBLIC_SCHEME` (https), `PUBLIC_PORT`, `DATA_DIR`.

## Як це влаштовано

```
телефон → Cloudflare / relay / Wi-Fi → інспектор (127.0.0.1:випадковий) → localhost:3000
```

- `src/core/inspector.js`: локальний проксі, який записує журнал.
- `src/core/relay-client.js` + `server/relay-server.js`: один WebSocket на тунель, усередині мультиплексовані HTTP/WS-потоки (`shared/protocol.js`). Автоперепідключення, ping, backpressure.
- `src/core/cloudflared.js`: завантаження й запуск `cloudflared tunnel --url`.
- `src/core/tunnel-manager.js`: життєвий цикл тунелів, не залежить від Electron.
- `src/main/*`: Electron (main + preload). `src/renderer/*`: інтерфейс без фреймворків.

## Тести

```bash
npm test
```

Наскрізні перевірки ядра без Electron: HTTP, POST, gzip, кілька Set-Cookie, SSE, 5 МБ, WebSocket, 404/502, невірний токен, перепідключення, LAN, підміна Host, парсинг виводу cloudflared.

## Якщо щось не так

- **LAN не відкривається з телефона:** Windows Firewall питає дозвіл для DevBridge під час першого запуску LAN-тунелю. Дозволь для приватних мереж.
- **Vite: «Blocked request. This host is not allowed»:** увімкни «Підміняти Host» або додай домен у `server.allowedHosts`.
- **Cloudflare 429:** Cloudflare обмежує часте створення quick-тунелів. Зачекай хвилину.
- **SSE через Cloudflare quick tunnel** може не працювати. Для SSE бери свій сервер.
