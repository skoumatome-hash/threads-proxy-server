const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookie解析
function parseCookies(input) {
  const cookies = [];
  if (!input) return cookies;
  const trimmed = input.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          cookies.push({
            name: c.name,
            value: c.value,
            domain: ".threads.net",
            path: "/",
            secure: true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
          });
        });
      }
    } catch (e) { console.error("Cookie JSON解析エラー:", e); }
  } else {
    trimmed.split(';').forEach(part => {
      const [key, ...v] = part.trim().split('=');
      if (key && v.length > 0) {
        cookies.push({
          name: key,
          value: v.join('='),
          domain: ".threads.net",
          path: "/",
          secure: true
        });
      }
    });
  }
  return cookies;
}

// プロキシ解析
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  if (!proxyStr.startsWith("http")) {
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
      return { server: `${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
    }
  }
  try {
    const url = new URL(proxyStr.startsWith("http") ? proxyStr : `http://${proxyStr}`);
    return { server: `${url.hostname}:${url.port}`, username: url.username, password: url.password };
  } catch (e) { return null; }
}

// メイン処理
async function runPuppeteerPost(task) {
  let browser = null;
  try {
    console.log("🚀 ブラウザ起動準備...");
    
    const proxyData = parseProxy(task.proxy);
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-notifications',
      '--window-size=1920,1080' // PCサイズを大きく確保
    ];

    if (proxyData) {
      args.push(`--proxy-server=${proxyData.server}`);
      console.log(`🌐 プロキシ設定: ${proxyData.server}`);
    }

    browser = await puppeteer.launch({ args: args, headless: "new" });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    if (proxyData && proxyData.username) {
      await page.authenticate({ username: proxyData.username, password: proxyData.password });
      console.log("🔑 プロキシ認証設定完了");
    }

    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 Cookie ${cookies.length}個をセットしました`);
    }

    console.log("🌍 Threadsにアクセス中...");
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 90000 });

    // 画面チェック
    const pageTitle = await page.title();
    console.log(`👀 ページタイトル: ${pageTitle}`);

    // ★修正: 「Start a thread」または「スレッドを開始」という文字を探してクリックする
    // CSSセレクタではなく、テキストの中身で探すので確実です
    console.log("🔍 投稿エリアを探しています...");
    
    // 少し待つ
    await new Promise(r => setTimeout(r, 5000));

    const inputFound = await page.evaluate(() => {
      // 画面内のすべての要素から、特定の文字を含むものを探す
      const elements = Array.from(document.querySelectorAll('div, span, p'));
      for (const el of elements) {
        if (el.innerText === "Start a thread..." || el.innerText === "スレッドを開始..." || el.innerText.includes("Start a thread")) {
          el.click(); // 見つけたら即クリック
          return true;
        }
      }
      return false;
    });

    if (inputFound) {
      console.log("✅ 投稿エリアを発見・クリックしました");
    } else {
      // 見つからない場合、ページ構造が変わっているか、英語設定かもしれない
      // "Post"ボタンなどが押せる状態か確認するために、とりあえずtabキーを押してみる等の策もあるが
      // ここでは汎用的なクラス名で再トライ
      console.log("⚠️ テキストで見つかりませんでした。CSSセレクタで再トライします...");
      try {
        await page.waitForSelector('div[role="textbox"], div[data-lexical-editor="true"]', { timeout: 5000 });
        await page.click('div[role="textbox"], div[data-lexical-editor="true"]');
        console.log("✅ セレクタで投稿エリアをクリックしました");
      } catch (e) {
        // 最終確認: ログイン画面かどうか
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes("Log in with Instagram")) {
          throw new Error("ログイン画面が表示されています。Cookieが無効です。");
        }
        console.log("現在の画面テキスト(抜粋): " + bodyText.substring(0, 100));
        throw new Error("投稿エリアが見つかりませんでした。");
      }
    }

    await new Promise(r => setTimeout(r, 2000));

    console.log("✍️ テキスト入力中...");
    // フォーカスされているはずなので、キーボード入力として送る
    await page.keyboard.type(task.text, { delay: 50 });
    await new Promise(r => setTimeout(r, 3000));

    // 「Post」ボタンをクリック
    console.log("🔘 投稿ボタンを探しています...");
    const postClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      for (const btn of buttons) {
        if (btn.innerText === "Post" || btn.innerText === "投稿") {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (postClicked) {
      console.log("✅ 投稿ボタンをクリックしました");
      await new Promise(r => setTimeout(r, 8000)); // 完了待ち
      console.log(`🎉 投稿処理完了: ${task.username}`);
    } else {
      throw new Error("投稿ボタンが見つかりませんでした（入力は完了しています）");
    }

  } catch (error) {
    console.error(`❌ 処理失敗: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 ブラウザを閉じました");
    }
  }
}

app.post("/api/check", async (req, res) => {
  res.json({ status: "success", message: "★Puppeteerサーバー稼働中！「投稿」を実行してください。" });
});

app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始 (Puppeteer): ${task.username} ---`);
    try {
      await runPuppeteerPost(task);
    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }
    if (requestQueue.length > 0) {
      console.log("☕ 休憩中...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
