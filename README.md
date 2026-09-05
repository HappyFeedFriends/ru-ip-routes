# RU IP Routes

Автоматически формируемые IPv4-маршруты для split tunneling. Проект отдельно собирает адреса российских сервисов из [`v2fly/domain-list-community`](https://github.com/v2fly/domain-list-community) и российские сети из [`v2fly/geoip`](https://github.com/v2fly/geoip), а затем создаёт объединённый список.

GitHub Actions запускает генерацию каждые 8 часов. Если содержимое списков не изменилось, workflow не создаёт коммит и не обновляет релиз `latest`.

## Готовые файлы

- `output/ru-services-ipv4.txt` — точные публичные IPv4 российских сервисов, найденные через DNS.
- `output/ru-services-cidr.txt` — адреса сервисов, lossless-сжатые в CIDR, плюс ручные CIDR из `include.txt`.
- `output/ru-geoip-cidr.txt` — IPv4-сети, классифицированные `v2fly/geoip` как российские.
- `output/ru-combined-cidr.txt` — объединение сервисного и GeoIP-списков без дубликатов и пересечений.
- `output/amnezia-full.json` — полный объединённый список в формате импорта AmneziaVPN; предназначен прежде всего для настольных систем.
- `output/amnezia-lite.json` — компактный список для iOS и Android: GeoIP-префиксы только тех российских сетей, где найдены нужные сервисы, плюс зарубежные CDN-адреса сервисов как `/32`.

Постоянные ссылки после публикации репозитория `HappyFeedFriends/ru-ip-routes`:

```text
https://raw.githubusercontent.com/HappyFeedFriends/ru-ip-routes/main/output/ru-services-cidr.txt
https://raw.githubusercontent.com/HappyFeedFriends/ru-ip-routes/main/output/ru-geoip-cidr.txt
https://raw.githubusercontent.com/HappyFeedFriends/ru-ip-routes/main/output/ru-combined-cidr.txt
https://github.com/HappyFeedFriends/ru-ip-routes/releases/download/latest/ru-combined-cidr.txt
https://github.com/HappyFeedFriends/ru-ip-routes/releases/download/latest/amnezia-full.json
https://github.com/HappyFeedFriends/ru-ip-routes/releases/download/latest/amnezia-lite.json
```

## Как формируется список

1. Генератор через HTTPS загружает архив актуальной ветки `master` v2fly и распаковывает каталог `data` в памяти — `git clone` и локальный кэш не нужны.
2. Рекурсивно раскрывает `include:` из `category-ru`, учитывает фильтры атрибутов и `&`-аффилиации формата v2fly.
3. Добавляет сервисные записи из `config/include.txt` и запрашивает A-записи через системный DNS, Yandex DNS и Cloudflare DNS.
4. Загружает готовый `release/text/ru.txt` из `v2fly/geoip` и оставляет только IPv4.
5. Вычитает IP/CIDR из `config/exclude.txt` из обоих источников.
6. Сортирует и lossless-объединяет каждый набор CIDR.
7. Строит полный и мобильный JSON для импорта в AmneziaVPN.
8. Записывает отдельные сервисный и GeoIP-наборы, их объединение и конфигурации AmneziaVPN.

Файлы не содержат дату генерации, поэтому одинаковый результат побайтно совпадает с предыдущим.

## Ручные правила

В `config/include.txt` можно указывать:

```text
domain:example.ru
full:www.example.ru
category:category-bank-ru
ip:8.8.8.8
cidr:1.1.1.0/24
```

В `config/exclude.txt` поддерживаются домены, IP и CIDR. Исключение домена также исключает его поддомены. IP/CIDR вычитаются из сервисного, GeoIP и объединённого наборов:

```text
domain:example.ru
8.8.8.8
1.1.1.0/24
```

## Локальный запуск

Требуется Node.js 22 или новее.

```bash
npm run generate
```

Во время работы генератор выводит восемь этапов: загрузку доменной базы, раскрытие категорий, DNS-прогресс, загрузку GeoIP, фильтрацию, объединение, формирование конфигураций AmneziaVPN и запись результатов.

Каждый запуск сам получает свежую базу. Для офлайн-режима можно передать путь к уже имеющейся локальной копии:

```bash
npm run generate -- --data /path/to/domain-list-community/data
```

DNS-серверы и параллелизм настраиваются переменными окружения:

```bash
DNS_SERVERS=system,77.88.8.8,1.1.1.1 DNS_CONCURRENCY=40 npm run generate
```

URL архива можно переопределить через `DOMAIN_LIST_URL` или аргумент `--source-url`.
Источник GeoIP переопределяется через `GEOIP_URL` или `--geoip-url`.

## Импорт в AmneziaVPN

AmneziaVPN поддерживает только IPv4 для IP-based split tunneling. Откройте настройки соединения → **Раздельное туннелирование сайтов** → выберите режим **Адреса из списка не должны открываться через VPN** → меню `⋮` → замените или дополните список импортом JSON.

- На Windows/macOS/Linux сначала попробуйте `amnezia-full.json`.
- На iOS и Android используйте `amnezia-lite.json`.

Перед импортом добавьте IP своего VPN-сервера в `config/exclude.txt`. Если адрес сервера попадёт в обходной список, AmneziaVPN может потерять соединение с самим туннелем — это отдельно отмечено в [официальной инструкции](https://docs.amnezia.org/documentation/instructions/vpn-split-tunneling/#faq).

Lite-файл не обрезается до произвольного числа строк: это потеряло бы сервисы непредсказуемым образом. Вместо этого каждый российский IP сервиса заменяется содержащим его российским GeoIP-префиксом, а адреса зарубежных CDN сохраняются как `/32`.

## Важные ограничения

- `category-ru` содержит правила верхнего уровня `.ru` и `.рф`. DNS нельзя использовать для перечисления всех зарегистрированных доменов зоны, поэтому генератор берёт все явно перечисленные и рекурсивно подключённые домены, но игнорирует правила, состоящие только из TLD.
- DNS — это снимок: CDN может возвращать разные адреса в зависимости от резолвера и региона. Опрос нескольких резолверов уменьшает, но не устраняет эту особенность.
- `ru-services-cidr.txt` является DNS-снимком и может содержать зарубежные CDN-адреса российских сервисов.
- `ru-geoip-cidr.txt` содержит сети, классифицированные базой геолокации как российские, но не гарантирует физическое местонахождение каждого сервера.
- `ru-combined-cidr.txt` обеспечивает максимальное покрытие, но будет самым большим списком маршрутов.
- `amnezia-lite.json` заметно меньше полного списка, но не охватывает российские сети, в которых не найден ни один домен из выбранных категорий.
- При успешном разрешении менее 20% доменов генерация прерывается, чтобы временная проблема DNS не затёрла рабочие результаты.
