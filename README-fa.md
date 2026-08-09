<h1 align="center">PasarGuard — فورک WireGuard و OpenVPN</h1>

<p align="center">
  فورکی از <a href="https://github.com/PasarGuard/panel">PasarGuard/panel</a> که WireGuard و
  OpenVPN را در کنار Xray اجرا می‌کند، چند هسته روی یک نود.
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

آپ‌استریم روی هر نود یک هسته اجرا می‌کند و Xray می‌فهمد. این فورک همهٔ آن را نگه می‌دارد و اینها را اضافه می‌کند:

**چند هسته روی یک نود.** یک نود می‌تواند هم‌زمان یک هستهٔ Xray و هر تعداد هستهٔ WireGuard و OpenVPN
داشته باشد. Xray همچنان یک نمونه می‌گیرد — یک پروسه به همهٔ اینباندهایش سرویس می‌دهد — ولی WireGuard و
OpenVPN بر اساس نمونه کلید می‌خورند، پس `wg-de` و `wg-us` روی یک ماشین کنار هم زندگی می‌کنند.

**هستهٔ OpenVPN، سرتاسری.** پنل نقش CA را بازی می‌کند: در اولین استفاده CA، گواهی سرور و کلید
`tls-crypt` خودش را می‌سازد، و اولین باری که هر کاربر اشتراکش را می‌گیرد یک گواهی کلاینت اختصاصی
برایش صادر می‌کند. احراز هویت با CN و سریال گواهی است، پس ابطال یک کاربر بقیه را به هم نمی‌ریزد.
یک هسته می‌تواند UDP و TCP را روی یک پورت سرو کند؛ نود برای هر listener یک پروسهٔ OpenVPN بالا
می‌آورد و سابنت را بینشان تقسیم می‌کند.

**صفحهٔ اشتراکی که فایل واقعی می‌دهد.** کاربر WireGuard یک `.conf` آمادهٔ همراه با QR می‌گیرد و
کاربر OpenVPN یک `.ovpn` آماده. هر دو برای هر هاست جداگانه ساخته می‌شوند، پس کسی که سه لوکیشن
WireGuard دارد سه فایل می‌گیرد.

**نصب‌کنندهٔ اختصاصی.** فایل `scripts/pasarguard.sh` فورکی از
[PasarGuard/scripts](https://github.com/PasarGuard/scripts) است که به همین مخزن و ایمیج آن اشاره
می‌کند، به‌همراه اصلاحاتی برای سرورهایی که فقط مال پنل نیستند — پایین‌تر بخوانید.

## نصب

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/AlirezaNorouzzadeh9/pasarguard/main/scripts/pasarguard.sh)" @ install --database mariadb
```

`--database` مقادیر `mariadb`، `mysql`، `postgresql`، `timescaledb` و `sqlite` را می‌پذیرد. بعد از
نصب، همان مجموعه‌دستورهای آپ‌استریم در دسترس است: `update`، `restart`، `status`، `logs`، `cli`،
`tui`، `backup`، `restore`، `install-node`، `uninstall`.

ایمیج روی هر پوش به `main` منتشر می‌شود:

```
ghcr.io/alirezanorouzzadeh9/pasarguard:latest
```

## چیزهایی که بهتر است قبل از استقرار بدانید

**پنل بدون TLS روی اینترنت گوش نمی‌دهد.** اگر گواهی تنظیم نشده باشد فقط روی localhost بایند می‌شود
و همین را در لاگ می‌گوید — سرو کردن لینک اشتراک روی HTTP ساده امن نیست. یا
`UVICORN_SSL_CERTFILE` و `UVICORN_SSL_KEYFILE` را به یک گواهی وصل کنید یا یک reverse proxy جلویش
بگذارید. برای گواهی self-signed حتماً `UVICORN_SSL_CA_TYPE` باید `private` باشد وگرنه پنل گواهی
خودش را رد می‌کند.

**کانتینر دیتابیس روی شبکهٔ هاست است.** روی سروری که از قبل MariaDB یا PostgreSQL برای چیز دیگری
دارد، نصب‌کننده به اولین پورت آزاد بعدی می‌رود و آن را در `DB_HOST_PORT` ثبت می‌کند. فقط شمارهٔ پورت
جابه‌جا می‌شود؛ دیتابیس همچنان به `127.0.0.1` بایند است.

**peerهای هر هستهٔ WireGuard از سابنت خودش می‌آیند.** بزرگ کردن سابنت امن است. جابه‌جا کردن یا کوچک
کردنش کانفیگ‌هایی را که قبلاً داده‌اید بی‌اعتبار می‌کند، چون آدرس peerها از محدودهٔ قبلی گرفته شده بود.

**کلید تکراری WireGuard کل هسته را می‌خواباند.** اگر دو کاربر یک کلید عمومی داشته باشند نود کل هسته
را رد می‌کند — نه می‌تواند ترافیک‌شان را تفکیک کند نه محدودیت اعمال کند. پنل‌هایی که از قبل از
پشتیبانی WireGuard مانده‌اند ممکن است کلید تکراری داشته باشند، چون آن موقع چک یکتایی اجرا نمی‌شد.
قبل از فعال کردن هستهٔ WireGuard روی دادهٔ واقعی، تعداد کلیدهای یکتا را با تعداد کاربران مقایسه کنید.

**فایل‌های گواهی در بکاپ دیتابیس نیستند.** کانفیگ Xray که گواهی را با مسیر صدا می‌زند به وجود آن
فایل‌ها نیاز دارد، وگرنه Xray کل هسته را رد می‌کند و همهٔ اینباندهایش ناپدید می‌شوند. موقع جابه‌جایی
پنل، پوشهٔ `/var/lib/pasarguard/certs/` را هم ببرید.

## آپ‌استریم

این یک فورک است نه جایگزین. هر چیزی که آپ‌استریم دربارهٔ کاربران، گروه‌ها، قالب‌ها، API و بات تلگرام
مستند کرده اینجا هم صادق است — به [مستندات PasarGuard](https://docs.pasarguard.org) و
[PasarGuard/panel](https://github.com/PasarGuard/panel) مراجعه کنید.

تحت لایسنس [AGPL-3.0](./LICENSE)، مثل آپ‌استریم.
