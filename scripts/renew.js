const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 环境变量获取
const EMAIL = process.env.H2P_EMAIL;
const PASSWORD = process.env.H2P_PASSWORD;
const TARGET_URL = process.env.RENEW_URL;
const PROXY_JSON = process.env.PROXY_JSON;

const EXTENSION_PATH = path.join(__dirname, 'extensions', 'nopecha', 'unpacked');

async function startProxy() {
    console.log('[初始化] 准备 Hysteria2 代理配置...');
    fs.writeFileSync('config.json', PROXY_JSON);

    console.log('[Hysteria2] starts...');
    const hysteria = spawn('hysteria', ['-c', 'config.json']);
    
    hysteria.stdout.on('data', (data) => console.log(`[Hysteria2 Log]: ${data}`));
    hysteria.stderr.on('data', (data) => console.error(`[Hysteria2 Error]: ${data}`));

    // 等待代理启动
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('[Hysteria2] socks5: 127.0.0.1:10808 预计已就绪');
    return hysteria;
}

async function run() {
    let proxyProcess;
    if (PROXY_JSON) {
        proxyProcess = await startProxy();
    }

    console.log('[Playwright] 启动中，并注入伪装特征...');
    const userDataDir = '/tmp/playwright_user_data';
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, 
        proxy: { server: 'socks5://127.0.0.1:10808' },
        // 伪装成正常的 Windows Chrome 用户
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled', // 最关键的一句：擦除自动化指纹
            '--ignore-certificate-errors'
        ]
    });

    const page = await context.newPage();
    console.log('[浏览器] 启动完成...');

    try {
        console.log('[页面] 访问公开续期链接...');
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // 刚进入页面，先等5秒让 JS 运行
        await page.waitForTimeout(5000); 

        // 检查是不是卡在 Loading 了
        const isLoading = await page.locator('text="Loading..."').isVisible();
        if (isLoading) {
            console.log('[警报] 页面卡在 Loading，遭遇后台拦截，尝试强制刷新突破...');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(10000); // 刷新后多等一会
        }

        // 【抓拍 1】：看一下突破后的画面
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'step1_after_load.png'), fullPage: true });
        console.log('[截图] 已保存加载后画面：step1_after_load.png');
        
        // ... 接下来的代码保持不变 (等待 20 秒，找按钮等) ...

        console.log('[交互] 等待页面加载和 NopeCHA 自动处理验证码 (等待 20 秒)...');
        await page.waitForTimeout(20000); 

        // 【新增抓拍 2】：等待 20 秒后的样子（看验证码是否通过）
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'step2_after_wait.png'), fullPage: true });
        console.log('[截图] 已保存等待后画面：step2_after_wait.png');

        // 查找并点击 Renew/确认 按钮 (扩大搜索范围，支持更多常见词汇)
        console.log('[交互] 查找续期按钮...');
        const renewButton = page.locator('button, a').filter({ hasText: /Renew|Confirm|Verify|Submit|续期|确认/i }).first();
        
        if (await renewButton.isVisible()) {
            await renewButton.click();
            console.log('[成功] 续期按钮已点击！');
            await page.waitForTimeout(5000); // 等待反馈弹窗
            
            // 【新增抓拍 3】：点击成功后的结果
            await page.screenshot({ path: path.join(__dirname, 'screenshots', 'step3_success.png'), fullPage: true });
        } else {
            console.log('[跳过] 未找到续期按钮。可能是：1. 验证码没通过 2. 按钮不叫这些名字。');
        }

    } catch (error) {
        console.error('[错误] 运行中断:', error);
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'error_crash.png'), fullPage: true });
    } finally {
        await context.close();
        if (proxyProcess) proxyProcess.kill();
        console.log('[结束] 任务完成，清理进程。');
    }
}

run();
