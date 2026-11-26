# Atom Lite + ENV III (BroadLink yerine)

M5Stack Atom Lite (IR LED GPIO12) + ENV III (SHT30 0x44, QMP6988 0x70, Grove: SDA GPIO26, SCL GPIO32).
Cihaz 15 sn'de bir `POST /api/device` ile sicaklik/nemi Worker'a yollar; cevapta bekleyen IR komutu gelir
(Worker, BroadLink kodlarini mikrosaniye dizisine cevirir).
`ack` bir sonraki raporda doner; onaylanmayan komut 5 dk icinde tekrar teslim edilir, sonra `ir_failed` olur + bildirim.

## Kurulum (cihaz gelince)

1. Worker tarafi (bir kez): `cd cloud && npx wrangler secret put DEVICE_KEY` (rastgele uzun deger). Ayarlanmazsa `VIEW_KEY` gecer.
   Deploy zaten `main`'de; yeni tablolar (`kv`, `ir_queue`) Worker ilk istekte kendisi olusturur.
2. `secrets.example.yaml` dosyasini `secrets.yaml` olarak kopyala, doldur (`device_url` = `https://<worker>.workers.dev/api/device`).
3. Atom Lite'i USB-C ile bilgisayara tak, Chrome'da https://web.esphome.io ac. Once ESPHome Dashboard/CLI ile derle:
   `esphome compile konfor-atom.yaml` ve `.bin` dosyasini web.esphome.io'dan "Install" ile yukle (ilk yukleme USB). Sonraki guncellemeler Wi-Fi OTA: `esphome run konfor-atom.yaml`.
4. ENV III'u Grove kablosuyla Atom Lite'a tak. Atom Lite'i klimanin onune, IR LED klimaya bakacak sekilde ve ENV III'u klima hava akisindan uzak bir yere koy.
5. Test (BroadLink hala acikken, sistem degismez): `GET /api/backend` (x-key: VIEW_KEY) `device` alaninda son rapor gorunur; `/api/diag` icinde de var.
6. Gecis: `curl -X POST -H "x-key: $VIEW_KEY" -d '{"mode":"esp"}' https://<worker>/api/backend`.
   Geri donus: ayni komut `{"mode":"broadlink"}`. Anlik, deploy gerekmez; BROADLINK_SESSION'a dokunma, geri donus icin dursun.
7. Gecisten sonra bir komut gonder, `/api/diag`'de `ir_queued` ve ardindan `ir_sent` (device ack) gorunmeli; klima tepki vermiyorsa LED'i klimaya yaklastir.

LED: acilista mavi, basarili rapor yesil yanip soner, sunucuya ulasilamazsa kirmizi. 20 ardisik basarisiz rapordan (~5 dk) sonra cihaz yeniden baslar.

## Dahili IR menzil testi

GPIO39 dugmesi Worker'dan bagimsiz olarak kayitli `off` komutunu bir kez gonderir. Atom Lite'in IR LED'ini klimanin alicisina dogrudan yonelt ve once 3-5 cm mesafeden dene. Her denemeden once klimayi kendi kumandasiyla ac. Ayni aciyla mesafeyi artirarak klimanin kapandigi mesafeyi kontrol et.

C008 semasinda GPIO12, D6 IR LED'ini 22 ohm seri direnc uzerinden dogrudan surer. Semada D6'nin parca numarasi ve akim siniri verilmez. ESPHome 2026.11.1 GPIO semasinda varsayilan surus ayari `20mA`, en yuksek secenek `40mA` degeridir. ESP32 RMT vericisi bu surumde YAML'daki `drive_strength` ayarini pine uygulamaz. [M5Stack C008 semasi](https://docs.m5stack.com/en/core/Atom-Lite#schematics), [ESPHome GPIO semasi](https://esphome.io/guides/configuration-types/#pin), [ESPHome 2026.11.1 RMT kaynak kodu](https://github.com/esphome/esphome/blob/2026.11.1/esphome/components/remote_transmitter/remote_transmitter_rmt.cpp)

M5Stack'in C008 ornegindeki aktif yuksek polarite ve %50 tasiyici doluluk orani kullanilir. Dugme ve Worker'in Atom Lite'a gonderdigi IR komutlari 38 kHz kullanir. Depodaki BroadLink kayitlarinda tekrar alani sifirdir. [M5Stack ESPHome ornegi](https://docs.m5stack.com/en/homeassistant/devices/atom_lite)
