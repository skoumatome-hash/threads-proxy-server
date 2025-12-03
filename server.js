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
    
    // ★ここで投稿内容を確認ログに出します
    console.log(`📝 投稿予定のテキスト: "${task.text.substring(0, 20)}..."`); 

    const proxyData = parseProxy(task.proxy);
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-notifications',
      '--window-size=1920,1080',
      '--lang=en-US' // 言語を英語に固定（セレクタ特定のため）
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
    }

    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 Cookie ${cookies.length}個をセットしました`);
    }

    console.log("🌍 Threadsにアクセス中...");
    
    // まずトップページへ
    await page.goto("https://www.threads.net/", { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    // 状態診断
    let bodyText = await page.evaluate(() => document.body.innerText.replace(/\n/g, ' '));
    console.log(`👀 トップページの状態: ${bodyText.substring(0, 100)}...`);

    if (bodyText.includes("Log in") || bodyText.includes("Instagram")) {
        console.log("⚠️ ログイン画面が検出されました。Cookieが無効かIP制限です。");
        // ここで止まらず、一応 create に行ってみる
    }

    // 投稿ページへ移動
    console.log("🔄 投稿ページ(threads.net/create)へ移動...");
    await page.goto("https://www.threads.net/create", { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 投稿入力欄を待つ
    const textBoxSelector = 'div[role="textbox"], div[data-lexical-editor="true"]';
    console.log("⏳ 投稿入力欄を待機中(最大30秒)...");
    
    try {
        await page.waitForSelector(textBoxSelector, { timeout: 30000 });
        console.log("✅ 入力欄を発見！");
    } catch (e) {
        // ★ここで犯人を特定するログを出す
        bodyText = await page.evaluate(() => document.body.innerText);
        console.log("\n================= 这里的画面 =================\n");
        console.log(bodyText.substring(0, 500)); // 画面の文字を500文字出す
        console.log("\n=============================================\n");
        throw new Error("入力欄が見つかりませんでした。画面の内容を上のログで確認してください。");
    }

    // 入力処理
    console.log("✍️ テキスト入力中...");
    await page.click(textBoxSelector);
    await new Promise(r => setTimeout(r, 1000));
    await page.keyboard.type(task.text, { delay: 100 });
    await new Promise(r => setTimeout(r, 2000));

    // 投稿ボタン
    console.log("🔘 投稿実行ボタンを探しています...");
    const postBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      return buttons.find(b => 
        (b.innerText.includes("Post") || b.innerText.includes("投稿")) && 
        !b.hasAttribute('disabled')
      );
    });

    if (postBtn) {
      await postBtn.click();
      console.log("✅ ボタンをクリックしました！");
      await new Promise(r => setTimeout(r, 10000));
      console.log(`🎉 投稿成功: ${task.username}`);
    } else {
      throw new Error("「投稿」ボタンが見つかりません。");
    }

  } catch (error) {
    console.error(`❌ 処理失敗: ${error.message}`);
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
