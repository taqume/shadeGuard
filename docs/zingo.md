# Zingo CLI adapter

ShadeGuard'ın tercih edilen gerçek testnet yolu:

```text
Retro Console / MCP Agent
          |
          v
Deterministic Policy Engine
          |
          v
ZingoCliProvider -- argument-vector subprocess --> zingo-cli (Ironwood beta)
                                                   |
                                                   v
                                      testnet Zcash indexer
```

## Neden Zingo?

Zingo CLI bir light wallet olduğu için yerel tam node senkronizasyonunu zorunlu kılmaz. Wallet keyleri yerel Zingo data directory içinde kalır. Bunun karşılığında indexer, istemcinin IP adresi ve shielded işlemlerle ilişkili olabilecek blok erişim metadata'sını öğrenebilir. Bu, Zcash zincir üstü gizliliğinden ayrı bir ağ metadata sınırıdır.

Adapter upstream komut sözleşmesini kullanır:

- `spendable_balance`: exact değer adapter içinde boolean'a indirgenir;
- `addresses`: yalnız testnet shielded receive address seçilir;
- `quicksend`: yalnız deterministik policy ve gerekiyorsa kullanıcı onayından sonra çağrılır;
- `transactions`: yalnız tek bir bilinen txid'nin durumunu adapter içinde bulmak için kullanılır; ham liste agent'a dönmez.

ShadeGuard hiçbir zaman `recovery_info`, `export_ufvk`, `messages`, `notes`, `value_transfers` veya raw command passthrough sunmaz.

## Güvenli çalıştırma

CLI `shell: false` ve ayrı argument vector ile başlatılır. Recipient testnet shielded olarak tekrar doğrulanır. Çıktı boyutu ve çalışma süresi sınırlıdır; stderr ve ham hata cevabı audit/agent yanıtına eklenmez. Wallet dosyasına eşzamanlı erişimi önlemek için komutlar serialize edilir.

Varsayılanlar:

```dotenv
SHADEGUARD_MODE=zingo
ZINGO_CLI_PATH=.shadeguard/zingolib/target/release/zingo-cli
ZINGO_DATA_DIR=.shadeguard/zingo-testnet
ZINGO_SERVER_URL=https://testnet.zec.rocks:443
ZINGO_WAIT_FOR_SYNC=true
```

`ZINGO_SERVER_URL` HTTPS olmalıdır; yalnız loopback adreslerinde HTTP kabul edilir. Mainnet runtime tarafından reddedilir.

## Kısa doğrulama

```bash
pnpm zingo:check
pnpm web
```

Gerçek receive-address veya ödeme çağrısı wallet'ın güncel hale gelmesini bekleyebilir. Bu, tam Zebra zincir senkronizasyonu değildir; yine de CI testlerine dahil edilmez ve gerçek testnet kabul testi yalnız açıkça istendiğinde çalıştırılır.

## Kalıcı wallet ve faucet

`.shadeguard/zingo-testnet` tek kalıcı testnet wallet'tır. Uygulama açılışında yeniden oluşturulmaz ve otomatik faucet talebi yapılmaz. Faucet rate-limitleri ve kötüye kullanım riski nedeniyle testler bu ana cüzdanı kullanır; görev bazlı ayrım gerekirse aynı wallet altında farklı alım adresleri tercih edilir.

Ironwood uyumlu [Fauzec](https://fauzec.com/) unified/Sapling adreslere 1 TAZ verir ve API sunar. Alternatif [ZecFaucet](https://zecfaucet.com/) insan doğrulaması ve proof-of-work isteyebilir. Faucet erişilebilirliği harici ve geçici bir bağımlılıktır; başarısız claim uygulama başlangıcını engellemez.
