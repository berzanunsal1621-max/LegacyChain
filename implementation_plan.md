# LegacyChain Dashboard UI Redesign Plan

Projenizin arayüzünü Trust Wallet ve modern Web3 cüzdan/dApp standartlarına uygun, çok daha profesyonel ve kullanıcı dostu bir hale getirmek için bir plan hazırladım. **Mevcut tüm fonksiyonlarınız (cüzdan bağlantısı, ping atma, varlık atama vb.) ve state (durum) yönetiminiz aynı kalacak**, sadece görsel sunum ve kullanıcı deneyimi (UX) iyileştirilecektir.

## Proposed Changes

### 1. Genel Düzen (Layout) Değişikliği (Sidebar Mimari)
Mevcut yatay tab yapısını, profesyonel dApp'lerde (örn. Trust Wallet Web, MetaMask Portfolio) sıkça kullanılan **Sidebar (Yan Menü) + Ana İçerik** yapısına geçireceğiz.
- **Sidebar Menüsü:** Dashboard (Panel), Assets (Varlıklar), Privacy (Gizlilik), ve Profile/Settings sekmeleri sol tarafta ikonlu ve şık bir dikey menü olarak yer alacak.
- **Top Bar (Üst Çubuk):** Ağ durumu, aktif cüzdan adresi ve "Disconnect" butonu üst kısımda minimal bir şekilde konumlanacak.

### 2. Action Hub (Hızlı İşlem Merkezi)
Trust Wallet arayüzündeki gibi ana ekranda kullanıcının en çok ihtiyaç duyduğu işlemleri belirgin hale getireceğiz.
- **Ana Kart (Hero Card):** Toplam bakiye, "Proof of Life Timer" (Hayat Kanıtı Sayacı) durumu ve cüzdan adresi geniş, gradyanlı veya glassmorphism etkili şık bir kartta gösterilecek.
- **Ana Aksiyon Butonları:** "Ping (Hayattayım)", "Deposit", "Withdraw" gibi ana fonksiyonlar bu ana kartın hemen altında büyük, anlaşılır ikonlu butonlar (Action Hub) olarak dizilecek.

### 3. Kart ve İçerik Tasarımları (Card & Typography Design)
- **Glassmorphism & Dark Mode:** Koyu tema ağırlıklı, yarı saydam paneller (`bg-white/5` veya `bg-gray-900/50`) ve ince, zarif kenarlıklar (`border-gray-800`) kullanılacak.
- **Modern Tipografi:** `Inter` veya `Outfit` gibi modern font ailesinin farklı ağırlıkları (font-bold, font-light) kullanılarak okunabilirlik artırılacak.
- **Durum İndikatörleri (Status Badges):** Oracle durumu, sistem sağlığı gibi kritik veriler Trust Wallet'taki gibi yeşil/kırmızı ışıklı minimal rozetlerle (badge) gösterilecek.

### 4. Animasyon ve Kullanıcı Geri Bildirimleri
- Sekmeler arası geçişlerde ve kartların üzerine gelindiğinde (hover) yumuşak geçiş (transition) efektleri eklenecek.
- İşlem bekleniyor (processing) durumları daha şık yükleme animasyonlarıyla (spinner veya skeleton loading) desteklenecek.

---

### [Component Name] Dashboard UI Redesign

Aşağıdaki dosyada UI güncellemeleri yapılacaktır. Fonksiyonlar değişmeyecektir.

#### [MODIFY] [index.html](file:///c:/Users/BerzanUnsal/OneDrive%20-%20Muğla%20Sıtkı%20Koçman%20Üniversitesi/Ceng_projects/LegacyChain/index.html)
- `const Dashboard` fonksiyonunun döndürdüğü HTML/JSX yapısı Sidebar + Main Content olarak yeniden yazılacak.
- CSS/Tailwind class'ları güncellenerek Trust Wallet tarzı Action Hub ve kart yapıları entegre edilecek.
- Mevcut `currentView` (assets, privacy vb.) logic'i yan menü ile senkronize çalışacak şekilde UI'a bağlanacak.

---

## User Review Required

> [!IMPORTANT]
> Bu tasarım değişikliği, uygulamanın Dashboard kısmının görünümünü tamamen değiştirecektir. **Arka plandaki hiçbir akıllı kontrat kodu veya React State'i bozulmayacaktır.** Sadece görsel bir makyaj ve yerleşim düzenlemesi yapılacaktır.
> Tasarım vizyonu (Sidebar düzeni + Trust Wallet tarzı Action Hub) sizin için uygun mu? Onaylarsanız uygulamaya (kodlamaya) başlayacağım.

## Verification Plan

### Manual Verification
- Arayüz kodlandıktan sonra yerel sunucuyu başlatıp, yeni Dashboard UI'ını tarayıcıda görsel olarak inceleyeceğim.
- Butonların (Ping, Deposit vb.) ve sekmelerin eskisi gibi sorunsuz çalıştığını test edeceğim.
