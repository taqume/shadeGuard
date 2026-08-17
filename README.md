# ShadeGuard

> Zcash paranızı gizler; ShadeGuard ise AI agentınızın onu yanlışlıkla açığa çıkarmasını engeller.

AI agentlar giderek finansal araçlara erişiyor. Zcash işlemleri zincir üzerinde gizli olsa bile bir agenta cüzdanın tamamını göstermek, tam bakiyeyi vermek veya geniş wallet yetkileri açmak bu mahremiyeti uygulama katmanında bozabilir. ShadeGuard agent ile Zcash arasına girer; yalnız görev için gereken minimum bilginin ve minimum yetkinin kullanılmasını sağlar, riskli işlemleri engeller, güvenli alternatifler önerir ve gerektiğinde kullanıcı onayı ister.

**Technical definition:** ShadeGuard is a privacy-aware MCP security gateway that enforces least-information, least-authority and privacy-preserving execution for AI agents interacting with Zcash.

## Çalışan sürüm

Mevcut vertical slice şunları içerir:

- a provider-independent canonical capability model;
- a deterministic, fail-closed policy engine;
- a privacy-safe MCP tool surface;
- gerçek, Ironwood uyumlu Zingo CLI testnet light-wallet adaptörü;
- Gemini veya NVIDIA NIM kullanan, policy yetkisi olmayan intent yorumlayıcısı;
- localhost ile sınırlı retro mobil web konsolu;
- yalnız testlerde kullanılan tekrar edilebilir sağlayıcı doubles;
- privacy-safe audit events and single-use approvals.

Üretim/demo web akışı sahte bakiye veya sahte işlem üretmez. `zingo-cli` bağlı değilse wallet açıkça offline görünür; agent ve policy önizlemesi çalışır ancak wallet operasyonları fail-closed reddedilir.

## Safety boundary

- Testnet only. Mainnet addresses, credentials, and funds are out of scope.
- Never paste a seed phrase, spending key, private key, or viewing key into chat.
- LLM output can explain or structure intent but can never produce an `ALLOW` decision.
- Raw downstream tools are never mirrored into the upstream MCP server.
- Exact balances, keys, full history, and raw sensitive memos must not enter agent responses, LLM context, or audit logs.

## Retro web demosu

Paylaşılan API anahtarını kaynak koda veya frontend'e koyma. Proje kökünde ignore edilen `.env` dosyasını oluştur:

```bash
cp .env.example .env
# Gemini: GEMINI_API_KEY; NVIDIA: AI_PROVIDER=nvidia ve NVIDIA_API_KEY
pnpm web
```

Ardından [http://127.0.0.1:4173](http://127.0.0.1:4173) adresini aç. Agent ekranı doğal dili seçilen AI sağlayıcısıyla canonical intent'e çevirir ve ayrı deterministik policy kararını gösterir. Bu ekran hiçbir zaman otomatik transfer yapmaz. Gerçek `can_afford`, receive-address ve send işlemleri yalnız Wallet sekmesindeki açık kullanıcı eylemleriyle çalışır.

API key yalnız server process'inde okunur; HTML/JavaScript bundle'ına, agent cevabına veya audit loguna eklenmez. Anahtar yoksa sistem deterministik yerel analiz moduna geçer.

## Zingo CLI testnet wallet

ShadeGuard varsayılan gerçek wallet yolu olarak Zingo CLI kullanır. Bu yol bir tam Zebra node'u senkronize etmez; Zingo bir testnet indexer'a bağlanan light client'tır. Önce kurulumu kontrol et:

```bash
pnpm zingo:check
```

Zcash testnet Temmuz 2026'da Ironwood/NU6.3'e geçti. Kararlı `zingolib_v5.0.0` bu yeni işlem biçiminde senkronizasyon hatası verdiği için şu anda Zingo'nun [resmî Ironwood beta etiketi](https://github.com/zingolabs/zingolib/tree/zingolib_beta_ironwood/zingo-cli) sabitlenmiştir. Etiket Rust 1.91, protobuf compiler ve build tools gerektiriyor:

```bash
rustup toolchain install 1.91.0 --profile minimal
git clone --branch zingolib_beta_ironwood --depth 1 https://github.com/zingolabs/zingolib.git
cd zingolib
cargo +1.91.0 build --release --locked -p zingo-cli
```

Sonra `.env` içindeki `ZINGO_CLI_PATH` değerini üretilen absolute binary yoluna ayarla. İlk gerçek wallet çağrısı `.shadeguard/zingo-testnet` altında yeni, yalnız-testnet bir wallet üretir. Bu dizin kalıcıdır; her başlatmada yeni wallet/faucet oluşturulmaz. ShadeGuard `recovery_info`, `export_ufvk`, `transactions` veya başka geniş yetkileri agent'a açmaz. Seed/private key'i sohbete, `.env` dosyasına veya frontend'e koyma.

Google pro aboneliği Gemini API kotası sağlamıyorsa geliştirme amaçlı ücretsiz NVIDIA NIM endpoint'i kullanılabilir. [NVIDIA API Catalog](https://build.nvidia.com/) üzerinden `nvapi-...` anahtarı oluşturup `.env` içinde `AI_PROVIDER=nvidia` ve `NVIDIA_API_KEY=...` ayarla. Varsayılan model `meta/llama-3.1-8b-instruct`; NIM erişimi Developer Program kapsamında prototipleme/geliştirme içindir, üretim lisansı değildir.

Zingo light-client kullanımı tam node yükünü kaldırır fakat seçilen indexer IP ve ilgili blok metadata'sını görebilir; bu upstream gizlilik sınırı [tehdit modelinde](docs/threat-model.md) açıkça kayıtlıdır.

## Development

Prerequisites: Node.js 22+, Corepack/pnpm, and Docker Desktop for the later testnet profile.

```bash
corepack enable
pnpm install
pnpm test
pnpm demo
```

Gerçek MCP acceptance demosu yalnız açık testnet-send opt-in'iyle çalışır. Fonlanmış kaynak wallet'ın `.env` içinde seçili olduğundan ve alıcı adresinin ayrı bir testnet wallet'a ait olduğundan emin ol:

```bash
SHADEGUARD_DEMO_RECIPIENT='utest1…' pnpm demo:testnet
```

Bu komut gerçek bir shielded testnet transferi yayınlar; normal `pnpm demo` ise mock provider kullanmaya devam eder.
Bilinen tek bir ödemeyi salt-okunur olarak MCP üzerinden sorgulamak için
`SHADEGUARD_DEMO_PAYMENT_ID='<txid>' pnpm demo:testnet:status` kullanılabilir.

## HTTP 402 paid API demosu

Bu demo genel amaçlı bir ödeme protokolü değildir; ShadeGuard'ın otomatik bir paid API ödemesini nasıl dar yetkiyle yönettiğini gösterir. Ayrı merchant testnet wallet adresini ve dizinini `.env` içinde `PAID_API_RECIPIENT` / `PAID_API_ZINGO_DATA_DIR` olarak ayarla. İlk terminalde:

```bash
pnpm paid-api
```

`GET /premium` önce shielded testnet ödeme koşuluyla HTTP `402` döndürür. İkinci terminaldeki agent challenge'ı okur, exact balance yerine `can_afford` çağırır, ödemeyi `shadeguard_safe_send` ile yapar, tek txid durumunu izler ve endpoint'i tekrar çağırır:

```bash
RUN_ZCASH_TESTNET_SEND=1 pnpm paid-api:client
```

Merchant servis yalnız kendi Zingo wallet'ında görünen, confirmed ve istenen minimum tutarı karşılayan incoming txid'yi kabul eder. Agent merchant'ın wallet geçmişini görmez.
Yayınlanmış bir ödeme sonrası süreç kesilirse yeni ödeme yapmadan
`PAID_API_PAYMENT_ID='<txid>' pnpm paid-api:client` ile doğrulama kaldığı yerden sürdürülebilir.

When a policy requires approval, keep the MCP server running and use a second terminal:

```bash
pnpm approval:list
pnpm approval:approve -- <approval-id>
```

The agent can then call the scoped resume tool with the original request ID. The one-use approval token remains inside ShadeGuard and is never disclosed to the agent.

Testler harici API veya Zcash kurulumu olmadan çalışır. Test doubles yalnız unit/integration test kapsamındadır; web runtime'ı bağlantı yokken gerçek olmayan wallet sonucu üretmez.

Architecture and security assumptions are documented in [docs/architecture.md](docs/architecture.md), [docs/threat-model.md](docs/threat-model.md), and [docs/testnet.md](docs/testnet.md).
The most recent real-chain evidence is recorded in [docs/live-acceptance.md](docs/live-acceptance.md).

## Legacy tam-node testnet yolu

Önceki `ShadeGuard -> Zallet -> Zebra` profili alternatif/legacy adapter testi için korunuyor fakat normal geliştirme ve demo için gerekli değil. Aşağıdaki çok saatli senkronizasyonu özellikle tam-node kabul testi istemiyorsan çalıştırma:

```bash
pnpm testnet:setup   # verify the pinned official Z3 configuration
pnpm testnet:up      # start the multi-hour Zebra public-testnet sync
pnpm testnet:status
pnpm testnet:wallet  # after Zebra is healthy; prints only the receive address
pnpm testnet:test    # read-only live adapter contract test
pnpm testnet:mcp     # start ShadeGuard against real Zallet
```

See [docs/testnet.md](docs/testnet.md) before starting the sync or funding the wallet.

Current upstream references:

- [Zingo CLI Ironwood beta](https://github.com/zingolabs/zingolib/tree/zingolib_beta_ironwood/zingo-cli)
- [Google Gen AI SDK](https://ai.google.dev/gemini-api/docs/libraries)
- [NVIDIA NIM API](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [Zallet installation and backend selection](https://zcash.github.io/zallet/guide/installation/index.html)
- [Zallet generated JSON-RPC reference](https://zcash.github.io/zallet/rpc/index.html)
- [Zebra](https://github.com/ZcashFoundation/zebra)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

MIT
