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
            domain: ".threads.net", // 強制的にthreads.netにする
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
      '--window-size=1280,800' // ★ウィンドウサイズを固定
    ];

    if (proxyData) {
      args.push(`--proxy-server=${proxyData.server}`);
      console.log(`🌐 プロキシ設定: ${proxyData.server}`);
    }

    browser = await puppeteer.launch({ args: args, headless: "new" });
    const page = await browser.newPage();

    // ★重要: 画面サイズをPC用にする
    await page.setViewport({ width: 1280, height: 800 });

    if (proxyData && proxyData.username) {
      await page.authenticate({ username: proxyData.username, password: proxyData.password });
      console.log("🔑 プロキシ認証設定完了");
    }

    // UA設定 (Windows Chromeのふり)
    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    // Cookieセット
    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 Cookie ${cookies.length}個をセットしました`);
    }

    console.log("🌍 Threadsにアクセス中...");
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 60000 });

    // ★デバッグ: 今、画面に何が表示されているか確認する
    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200).replace(/\n/g, ' '));
    console.log(`👀 現在のページタイトル: ${pageTitle}`);
    console.log(`👀 画面内のテキスト(先頭): ${bodyText}`);

    // ログイン判定
    // "Start a thread" (投稿エリア) があるか？
    // なければ "Log in" ボタンがあるか？
    const postInputSelector = 'div[data-lexical-editor="true"], div[role="textbox"]';
    const loginButtonSelector = 'a[href*="login"], div[role="button"]';

    try {
      await page.waitForSelector(postInputSelector, { timeout: 15000 });
      console.log("✅ ログイン確認OK (投稿エリア発見)");
    } catch (e) {
      // 投稿エリアが見つからない場合、ログインボタンがあるか確認
      console.log("⚠️ 投稿エリアが見つかりません。ログイン状態を確認します...");
      
      const isLoginPage = await page.evaluate(() => {
        return document.body.innerText.includes("Log in") || document.body.innerText.includes("Instagram");
      });

      if (isLoginPage) {
        throw new Error("【ログイン失敗】 ログイン画面が表示されています。Cookieが無効か、IPが変わってログアウトされました。");
      } else {
        throw new Error(`【不明なエラー】 投稿エリアもログインボタンも見つかりません。画面テキスト: ${bodyText}`);
      }
    }

    // 投稿処理
    await page.click(postInputSelector);
    await new Promise(r => setTimeout(r, 2000));

    console.log("✍️ テキスト入力中...");
    await page.type(postInputSelector, task.text, { delay: 100 });
    await new Promise(r => setTimeout(r, 3000));

    // 投稿ボタンクリック
    const [button] = await page.$x("//div[@role='button'][contains(., 'Post') or contains(., '投稿')]");
    if (button) {
      console.log("🔘 投稿ボタンをクリック...");
      await button.click();
      await new Promise(r => setTimeout(r, 8000));
      console.log(`✅ 投稿成功: ${task.username}`);
    } else {
      throw new Error("投稿ボタンが見つかりませんでした");
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
