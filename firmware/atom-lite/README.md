# Atom Lite + ENV III (BroadLink yerine)

M5Stack Atom Lite (IR LED GPIO12) + ENV III (SHT30 0x44, QMP6988 0x70, Grove: SDA GPIO26, SCL GPIO32).
Cihaz 15 sn'de bir `POST /api/device` ile sicaklik/nemi Worker'a yollar; cevapta bekleyen IR komutu gelir
(BroadLink kodlari Worker'da mikrosaniye dizisine cevrilir, firmware'de kod yok).
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
