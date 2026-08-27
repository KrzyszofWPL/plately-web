// ============================================================================
// Web-first copy, merged on top of landing-i18n.js.
//
// Two things changed and neither fits the original dictionary:
//
//   1. The product moved to the browser, so the download card now points at
//      app.plately.eu and the Huawei AppGallery build became the secondary
//      route rather than the only one.
//   2. The page needs a real <title> and description per language. They used
//      to be absent from the HTML entirely — see landing.js for why that was
//      the actual cause of the soft 404.
//
// Kept in a separate file so the twelve hand-written blocks in landing-i18n.js
// stay untouched and a future regeneration of that file does not silently drop
// these keys.
// ============================================================================

(function () {
  'use strict';

  var WEB = {
    pl: {
      ctaOpen: 'Otwórz aplikację',
      ctaAndroid: 'Wersja na Androida (AppGallery)',
      storeSub: 'Przeglądarka',
      sysreq: 'Android · iOS · Windows · macOS · 0 zł',
      ctaLead: 'Plately działa w przeglądarce — na telefonie, tablecie i komputerze. Bez instalowania, w 12 językach.',
      metaTitle: 'Plately — darmowy asystent diety, nawodnienia i wagi z AI',
      metaDesc: 'Plately zamienia zdjęcie posiłku w pełny rozkład makroskładników, pilnuje nawodnienia i prowadzi Cię do docelowej wagi. Trener AI, 12 języków, całkowicie za darmo.'
    },
    en: {
      ctaOpen: 'Open the app',
      ctaAndroid: 'Android version (AppGallery)',
      storeSub: 'Browser',
      sysreq: 'Android · iOS · Windows · macOS · free',
      ctaLead: 'Plately runs in your browser — on your phone, tablet and desktop. No install, in 12 languages.',
      metaTitle: 'Plately — free AI diet, hydration and weight assistant',
      metaDesc: 'Plately turns a photo of your meal into a full macro breakdown, keeps an eye on your hydration and guides you to your target weight. AI coach, 12 languages, completely free.'
    },
    de: {
      ctaOpen: 'App öffnen',
      ctaAndroid: 'Android-Version (AppGallery)',
      storeSub: 'Browser',
      sysreq: 'Android · iOS · Windows · macOS · kostenlos',
      ctaLead: 'Plately läuft im Browser — auf Handy, Tablet und Desktop. Ohne Installation, in 12 Sprachen.',
      metaTitle: 'Plately — kostenloser KI-Assistent für Ernährung, Wasser und Gewicht',
      metaDesc: 'Plately verwandelt ein Foto deiner Mahlzeit in eine vollständige Makro-Aufschlüsselung, achtet auf deine Flüssigkeitszufuhr und führt dich zum Zielgewicht. KI-Coach, 12 Sprachen, völlig kostenlos.'
    },
    uk: {
      ctaOpen: 'Відкрити застосунок',
      ctaAndroid: 'Версія для Android (AppGallery)',
      storeSub: 'Браузер',
      sysreq: 'Android · iOS · Windows · macOS · безкоштовно',
      ctaLead: 'Plately працює у браузері — на телефоні, планшеті й компʼютері. Без встановлення, 12 мовами.',
      metaTitle: 'Plately — безкоштовний ШІ-асистент харчування, води та ваги',
      metaDesc: 'Plately перетворює фото страви на повний розподіл макроелементів, стежить за водним балансом і веде вас до цільової ваги. ШІ-тренер, 12 мов, повністю безкоштовно.'
    },
    ru: {
      ctaOpen: 'Открыть приложение',
      ctaAndroid: 'Версия для Android (AppGallery)',
      storeSub: 'Браузер',
      sysreq: 'Android · iOS · Windows · macOS · бесплатно',
      ctaLead: 'Plately работает в браузере — на телефоне, планшете и компьютере. Без установки, на 12 языках.',
      metaTitle: 'Plately — бесплатный ИИ-ассистент питания, воды и веса',
      metaDesc: 'Plately превращает фото блюда в полный разбор макронутриентов, следит за водным балансом и ведёт вас к целевому весу. ИИ-тренер, 12 языков, полностью бесплатно.'
    },
    fr: {
      ctaOpen: "Ouvrir l'application",
      ctaAndroid: 'Version Android (AppGallery)',
      storeSub: 'Navigateur',
      sysreq: 'Android · iOS · Windows · macOS · gratuit',
      ctaLead: 'Plately fonctionne dans le navigateur — sur téléphone, tablette et ordinateur. Sans installation, en 12 langues.',
      metaTitle: "Plately — assistant IA gratuit pour l'alimentation, l'hydratation et le poids",
      metaDesc: "Plately transforme la photo d'un repas en répartition complète des macros, surveille votre hydratation et vous guide vers votre poids cible. Coach IA, 12 langues, entièrement gratuit."
    },
    it: {
      ctaOpen: "Apri l'app",
      ctaAndroid: 'Versione Android (AppGallery)',
      storeSub: 'Browser',
      sysreq: 'Android · iOS · Windows · macOS · gratis',
      ctaLead: 'Plately funziona nel browser — su telefono, tablet e computer. Senza installazione, in 12 lingue.',
      metaTitle: 'Plately — assistente IA gratuito per dieta, idratazione e peso',
      metaDesc: 'Plately trasforma la foto di un pasto in una ripartizione completa dei macronutrienti, tiene d’occhio l’idratazione e ti guida al peso desiderato. Coach IA, 12 lingue, completamente gratis.'
    },
    es: {
      ctaOpen: 'Abrir la app',
      ctaAndroid: 'Versión para Android (AppGallery)',
      storeSub: 'Navegador',
      sysreq: 'Android · iOS · Windows · macOS · gratis',
      ctaLead: 'Plately funciona en el navegador — en el móvil, la tablet y el ordenador. Sin instalación, en 12 idiomas.',
      metaTitle: 'Plately — asistente de IA gratuito de dieta, hidratación y peso',
      metaDesc: 'Plately convierte la foto de una comida en un desglose completo de macronutrientes, vigila tu hidratación y te guía hasta tu peso objetivo. Entrenador de IA, 12 idiomas, totalmente gratis.'
    },
    pt: {
      ctaOpen: 'Abrir a aplicação',
      ctaAndroid: 'Versão Android (AppGallery)',
      storeSub: 'Navegador',
      sysreq: 'Android · iOS · Windows · macOS · grátis',
      ctaLead: 'O Plately funciona no navegador — no telemóvel, tablet e computador. Sem instalação, em 12 idiomas.',
      metaTitle: 'Plately — assistente de IA gratuito de dieta, hidratação e peso',
      metaDesc: 'O Plately transforma a foto de uma refeição num desdobramento completo de macronutrientes, cuida da tua hidratação e guia-te até ao peso desejado. Treinador de IA, 12 idiomas, totalmente grátis.'
    },
    ja: {
      ctaOpen: 'アプリを開く',
      ctaAndroid: 'Android版（AppGallery）',
      storeSub: 'ブラウザ',
      sysreq: 'Android · iOS · Windows · macOS · 無料',
      ctaLead: 'Plately はブラウザで動きます — スマホ、タブレット、パソコンで。インストール不要、12言語対応。',
      metaTitle: 'Plately — 食事・水分・体重を管理する無料AIアシスタント',
      metaDesc: 'Plately は食事の写真からマクロ栄養素を自動で算出し、水分補給を見守り、目標体重まで導きます。AIコーチ、12言語、完全無料。'
    },
    zh: {
      ctaOpen: '打开应用',
      ctaAndroid: 'Android 版本（AppGallery）',
      storeSub: '浏览器',
      sysreq: 'Android · iOS · Windows · macOS · 免费',
      ctaLead: 'Plately 在浏览器中运行 — 手机、平板和电脑都可以。无需安装，支持 12 种语言。',
      metaTitle: 'Plately — 免费的 AI 饮食、饮水与体重助手',
      metaDesc: 'Plately 把一张餐食照片变成完整的宏量营养素分析，帮你关注饮水，并引导你达到目标体重。AI 教练，12 种语言，完全免费。'
    },
    ko: {
      ctaOpen: '앱 열기',
      ctaAndroid: 'Android 버전 (AppGallery)',
      storeSub: '브라우저',
      sysreq: 'Android · iOS · Windows · macOS · 무료',
      ctaLead: 'Plately는 브라우저에서 실행됩니다 — 휴대폰, 태블릿, 데스크톱에서. 설치 없이, 12개 언어로.',
      metaTitle: 'Plately — 식단·수분·체중을 위한 무료 AI 어시스턴트',
      metaDesc: 'Plately는 식사 사진을 완전한 매크로 영양소 분석으로 바꾸고, 수분 섭취를 챙기며, 목표 체중까지 이끌어 줍니다. AI 코치, 12개 언어, 완전 무료.'
    }
  };

  var dict = (window.PLATELY_I18N = window.PLATELY_I18N || {});
  Object.keys(WEB).forEach(function (code) {
    dict[code] = Object.assign({}, dict[code], WEB[code]);
  });
})();
