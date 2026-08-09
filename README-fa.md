<h1 align="center">PasarGuard — فورک WireGuard و OpenVPN</h1>

<p align="center">
  فورکی از <a href="https://github.com/PasarGuard/panel">PasarGuard/panel</a> که WireGuard و
  OpenVPN را کنار Xray اجرا می‌کند، چند هسته روی یک نود.
</p>

<p align="center">
  <a href="https://github.com/AlirezaNorouzzadeh9/pasarguard/actions/workflows/build-fork.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/AlirezaNorouzzadeh9/pasarguard/build-fork.yml?style=flat-square&label=image" />
  </a>
  <a href="https://github.com/AlirezaNorouzzadeh9/pasarguard/pkgs/container/pasarguard">
    <img src="https://img.shields.io/badge/ghcr.io-pasarguard-blue?style=flat-square&logo=docker" />
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/github/license/AlirezaNorouzzadeh9/pasarguard?style=flat-square" />
  </a>
</p>

<p align="center"><a href="./README.md">🇬🇧 English</a></p>

---

## این فورک چه چیزی اضافه می‌کند

**چند هسته روی یک نود.** یک نود می‌تواند هم‌زمان یک هستهٔ Xray و هر تعداد هستهٔ WireGuard و OpenVPN
داشته باشد. Xray یک نمونه می‌گیرد — یک پروسه به همهٔ اینباندهایش سرویس می‌دهد — ولی WireGuard و
OpenVPN بر اساس نمونه کلید می‌خورند، پس `wg-de` و `wg-us` روی یک ماشین کنار هم کار می‌کنند.

**هستهٔ OpenVPN، سرتاسری.** پنل نقش CA را دارد: در اولین استفاده CA، گواهی سرور و کلید `tls-crypt`
خودش را می‌سازد و اولین بار که هر کاربر اشتراکش را می‌گیرد یک گواهی کلاینت اختصاصی صادر می‌کند.
احراز هویت با CN و سریال گواهی است، پس ابطال یک کاربر بقیه را به هم نمی‌ریزد. یک هسته می‌تواند UDP
و TCP را روی یک پورت بدهد؛ نود برای هر listener یک پروسه بالا می‌آورد و سابنت را تقسیم می‌کند.

**صفحهٔ اشتراکی که فایل واقعی می‌دهد.** کاربر WireGuard یک `.conf` آماده با QR می‌گیرد و کاربر
OpenVPN یک `.ovpn` آماده. هر دو برای هر هاست جداگانه ساخته می‌شوند.

**نصب‌کنندهٔ اختصاصی**، فورک‌شده از [PasarGuard/scripts](https://github.com/PasarGuard/scripts) و
نشانه‌گیری‌شده به همین مخزن و ایمیج آن، به‌همراه اصلاحاتی برای سرورهایی که فقط مال پنل نیستند.

---

## نصب

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/AlirezaNorouzzadeh9/pasarguard/main/scripts/pasarguard.sh)" @ install --database mariadb
```

نصب‌کننده ایمیج `ghcr.io/alirezanorouzzadeh9/pasarguard:latest` را می‌کشد، `/opt/pasarguard` را
می‌سازد و خودش را به‌عنوان دستور `pasarguard` نصب می‌کند.

### انتخاب دیتابیس

| `--database` | رابط مدیریت روی :8010 | چه زمانی |
|---|---|---|
| `mariadb` | phpMyAdmin | انتخاب پیش‌فرض، و اگر از پنل MySQL/MariaDB مهاجرت می‌کنید همین |
| `mysql` | phpMyAdmin | وقتی مشخصاً به رفتار MySQL نیاز دارید |
| `postgresql` | pgAdmin | اگر پستگرس را ترجیح می‌دهید؛ pgbouncer هم هست |
| `timescaledb` | pgAdmin | اگر آمار مصرف نودها در طول زمان را می‌خواهید |
| `sqlite` | — | برای امتحان کردن. کانتینر دیتابیس جدا ندارد |

آمار مصرف نودها (`ENABLE_RECORDING_NODES_STATS`) فقط روی PostgreSQL/TimescaleDB کار می‌کند.

**همان موتوری را بگیرید که از آن مهاجرت می‌کنید.** دامپ MariaDB نسخهٔ ۱۱.۴ به بالا از collation
به‌نام `utf8mb4_0900_ai_ci` استفاده می‌کند، و سرور قدیمی‌تر آن را **رد نمی‌کند** — با متن خراب
وارد می‌کند. اگر پنل فعلی‌تان MariaDB است، با `--database mariadb` نصب کنید.

### بقیهٔ فلگ‌ها

| فلگ | کار |
|---|---|
| `--version v1.2.3` | نصب یک تگ مشخص به‌جای `latest` |
| `--pre-release` | اجازهٔ نسخه‌های پیش‌انتشار |
| `--dev` | نصب از ایمیج توسعه |
| `--ssl-domain example.com` | گرفتن گواهی Let's Encrypt برای این دامنه حین نصب |
| `--no-ssl` | رد شدن از تنظیم گواهی — نکتهٔ TLS پایین را بخوانید |

Let's Encrypt از acme.sh در حالت standalone استفاده می‌کند که **پورت ۸۰ باید آزاد و از بیرون قابل
دسترس** باشد. روی سروری که وب‌سرور دارد، یا موقتاً خاموشش کنید یا TLS را بعداً تنظیم کنید.

---

## بعد از نصب

### ساخت اولین ادمین

```bash
pasarguard cli admin create --sudo
```

اگر بکاپ ریستور کرده‌اید لازم نیست — ادمین‌های خود بکاپ برمی‌گردند.

### پنل بدون TLS روی اینترنت گوش نمی‌دهد

اگر گواهی تنظیم نشده باشد، پنل فقط روی `localhost` بایند می‌شود و همین را در لاگ می‌گوید. این
عمدی است: لینک اشتراکی که روی HTTP ساده سرو شود امن نیست. گواهی را معرفی کنید:

```bash
pasarguard edit-env
```

```ini
UVICORN_SSL_CERTFILE = "/var/lib/pasarguard/certs/example.com/fullchain.pem"
UVICORN_SSL_KEYFILE  = "/var/lib/pasarguard/certs/example.com/key.pem"
UVICORN_SSL_CA_TYPE  = "public"
```

بعد `pasarguard restart`. برای گواهی **self-signed** حتماً `UVICORN_SSL_CA_TYPE` باید `private`
باشد وگرنه پنل گواهی خودش را به جرم نیامدن از یک CA معتبر رد می‌کند. راه دیگر این است که پنل روی
loopback بماند و nginx یا Caddy جلویش بگذارید.

---

## بکاپ و ریستور

### گرفتن بکاپ

```bash
pasarguard backup
```

آرشیو را در `/opt/pasarguard/backup/` می‌گذارد — همان پوشه‌ای که `restore` می‌خواند.

`pasarguard backup-service` بکاپ دوره‌ای با ارسال به تلگرام راه می‌اندازد.

### ریستور بکاپی که خود این نصب‌کننده ساخته

```bash
pasarguard restore
```

آرشیوهای داخل `/opt/pasarguard/backup/` را فهرست می‌کند و می‌پرسد کدام. **مسیر فایل نمی‌گیرد.**

### ریستور دامپی که از جای دیگر آمده

`restore` آرشیوی می‌خواهد که داخلش فایلی به نام **`db_backup.sql`** در ریشه باشد. یک `.sql` یا
`.sql.gz` خام از `mysqldump` پیدا می‌شود ولی بعد رد می‌شود، پس اول بسته‌بندی‌اش کنید:

```bash
mkdir -p /opt/pasarguard/backup && rm -rf /tmp/pgbk && mkdir /tmp/pgbk && cp /root/your-dump.sql /tmp/pgbk/db_backup.sql && tar czf /opt/pasarguard/backup/imported.tar.gz -C /tmp/pgbk db_backup.sql && rm -rf /tmp/pgbk && pasarguard restore
```

اگر دامپ gzip است، `cp` را با `gunzip -c /root/your-dump.sql.gz > /tmp/pgbk/db_backup.sql` عوض کنید.

مایگریشن‌های اسکیما موقع استارت پنل خودکار اجرا می‌شوند، پس دامپ نسخهٔ قدیمی‌تر بدون قدم اضافه
به‌روز می‌شود.

### دو چیزی که در بکاپ دیتابیس نیست

**فایل‌های گواهی.** کانفیگ Xray که گواهی را با مسیر صدا می‌زند به وجود آن فایل‌ها نیاز دارد. بدون
آن‌ها Xray **کل هسته** را رد می‌کند، همهٔ اینباندهایش ناپدید می‌شوند و هاست‌هایی که به آن‌ها اشاره
داشتند بی‌صاحب می‌مانند. پوشهٔ `/var/lib/pasarguard/certs/` را جداگانه ببرید.

**وضعیت نودها.** هر نود در بکاپ همان وضعیتی را دارد که داشته. اگر بکاپی را ریستور کنید که نودهایش
`connected` بوده‌اند، پنل لحظهٔ استارت به آن‌ها وصل می‌شود — و اگر پنلی که بکاپ از آن آمده هنوز
روشن باشد، هر دو سر یک نود دعوا می‌کنند و کاربران قطع می‌شوند. برای ریستور یک کپی تستی، بین
ایمپورت و استارت نودها را بخوابانید:

```bash
cd /opt/pasarguard && RP=$(grep '^MYSQL_ROOT_PASSWORD' .env | cut -d= -f2- | tr -d '"') && DB=$(grep '^DB_NAME' .env | cut -d= -f2- | tr -d '"') && docker exec -i pasarguard-mariadb-1 mariadb -uroot -p"$RP" -D "$DB" -e "UPDATE nodes SET status='disabled';"
```

---

## دستورها

| | |
|---|---|
| `install` `update` `uninstall` | چرخهٔ عمر. `update` ایمیج جدید را می‌کشد و بازسازی می‌کند |
| `up` `down` `restart` `status` | کنترل و بررسی استک |
| `logs` | دنبال کردن لاگ پنل |
| `cli` `tui` | خط فرمان و رابط ترمینالی خود پنل |
| `backup` `backup-service` `restore` | همان بالا |
| `core-update` | به‌روزرسانی باینری هستهٔ Xray |
| `edit` `edit-env` | باز کردن `docker-compose.yml` یا `.env` در ویرایشگر |
| `install-node` | نصب نود روی همین ماشین |
| `install-script` `completion` | نصب دوبارهٔ خود دستور، یا تکمیل خودکار شل |

---

## عیب‌یابی

**`Access denied for user 'pasarguard'` و ری‌استارت بی‌پایان.** پوشهٔ دادهٔ دیتابیس از نصب قبلی
مانده. MariaDB فقط روی پوشهٔ خالی کاربر را می‌سازد، پس رمز قدیمی را نگه داشته در حالی که نصب دوباره
رمز تازه ساخته. یا رمز قدیمی را در `.env` برگردانید یا رمز حساب را داخل دیتابیس ریست کنید.
`pasarguard uninstall` می‌پرسد داده هم پاک شود یا نه — جواب منفی همان چیزی است که پوشه را جا
می‌گذارد.

**`port 3306 is already in use`.** فقط روی نسخه‌های خیلی قدیمی این نصب‌کننده. نسخهٔ فعلی به اولین
پورت آزاد بعدی می‌رود و آن را در `DB_HOST_PORT` ثبت می‌کند؛ دیتابیس همچنان به `127.0.0.1` بایند
است و فقط شمارهٔ پورت جابه‌جا می‌شود.

**پنل بالا می‌آید ولی از بیرون جواب نمی‌دهد.** روی localhost بایند شده چون گواهی TLS تنظیم نشده.
نکتهٔ TLS بالا را ببینید — لاگ خودش صریح این را می‌گوید.

**هاست‌ها اینباند خالی دارند و بخش Xray خالی است.** هستهٔ Xray لود نشده. معمولاً یکی از فایل‌های
گواهی که کانفیگ صدا می‌زند غایب است:

```bash
docker logs pasarguard-pasarguard-1 2>&1 | grep -iE 'cert|core' | tail
```

**هستهٔ WireGuard بالا نمی‌آید: «public key is assigned to multiple users».** دو کاربر یک کلید
دارند و نود کل هسته را رد می‌کند به‌جای اینکه peerهایی را سرو کند که نمی‌تواند از هم تفکیک کند.
پنل‌هایی که از قبل از پشتیبانی WireGuard مانده‌اند ممکن است کلید تکراری داشته باشند، چون چک یکتایی
فقط برای کاربرانی اجرا می‌شود که گروهشان از قبل دسترسی WireGuard دارد. قبل از فعال کردن هستهٔ
WireGuard روی دادهٔ واقعی، تعداد کاربران را با تعداد کلیدهای یکتا مقایسه کنید.

**کلاینت WireGuard وصل می‌شود ولی فقط بعضی سایت‌ها باز می‌شوند.** معمولاً نبودِ خط `DNS` در
`.conf` تولیدشده است نه MTU. مقدار DNS روی هر هاست زیر `wireguard_overrides` تنظیم می‌شود.

---

## آپ‌استریم

این یک فورک است نه جایگزین. هر چیزی که آپ‌استریم دربارهٔ کاربران، گروه‌ها، قالب‌ها، API و بات
تلگرام مستند کرده اینجا هم صادق است — [مستندات PasarGuard](https://docs.pasarguard.org) و
[PasarGuard/panel](https://github.com/PasarGuard/panel).

تحت لایسنس [AGPL-3.0](./LICENSE)، مثل آپ‌استریم.
