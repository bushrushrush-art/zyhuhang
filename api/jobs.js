// api/jobs.js

const CACHE_TTL_MS = 60 * 1000;

// Vercel 单实例内存缓存：同一个实例短时间内会复用
// 注意：Serverless 内存缓存不是永久缓存，但足够减少短时间重复读取飞书
const cacheStore = {};

function getCacheEntry(cacheKey) {
    if (!cacheStore[cacheKey]) {
        cacheStore[cacheKey] = {
            data: null,
            expiresAt: 0,
            loadingPromise: null
        };
    }

    return cacheStore[cacheKey];
}

function checkEnv() {
    const required = [
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "FEISHU_APP_TOKEN",
        "FEISHU_TABLE_ID"
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`Vercel 环境变量缺失：${missing.join(", ")}`);
    }
}

function parseTime(value) {
    if (!value) return 0;

    if (typeof value === "number") {
        return value;
    }

    const str = String(value).trim();
    if (!str) return 0;

    const num = Number(str);
    if (!Number.isNaN(num) && num > 1000000000000) {
        return num;
    }

    const ms = new Date(str.replace(/-/g, "/")).getTime();

    if (Number.isNaN(ms)) {
        return 0;
    }

    return ms;
}

function getText(value, fallback = "") {
    if (value === undefined || value === null) return fallback;

    if (Array.isArray(value)) {
        return value
            .map(item => getText(item, ""))
            .filter(Boolean)
            .join(", ");
    }

    if (typeof value === "object") {
        return (
            value.text ||
            value.name ||
            value.value ||
            value.link ||
            fallback
        );
    }

    return String(value);
}

function getUrl(value) {
    if (!value) return "";

    if (typeof value === "string") {
        const text = value.trim();

        if (text.startsWith("http://") || text.startsWith("https://")) {
            return text;
        }

        return "";
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const url = getUrl(item);
            if (url) return url;
        }

        return "";
    }

    if (typeof value === "object") {
        const link = String(value.link || value.url || "").trim();

        if (link.startsWith("http://") || link.startsWith("https://")) {
            return link;
        }

        return "";
    }

    return "";
}

/**
 * 飞书「超链接」字段通常是：
 * {
 *   text: "投递邮箱：xxx@xxx.com",
 *   link: "https://mp.weixin.qq.com/..."
 * }
 *
 * 前端要识别邮箱，必须拿到 text。
 */
function getApplyText(value) {
    if (value === undefined || value === null) return "";

    if (Array.isArray(value)) {
        return value
            .map(item => getApplyText(item))
            .filter(Boolean)
            .join(", ");
    }

    if (typeof value === "object") {
        return String(
            value.text ||
            value.name ||
            value.value ||
            value.link ||
            ""
        ).trim();
    }

    return String(value || "").trim();
}

function extractEmails(value) {
    const text = String(value ?? "");
    const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);

    if (!matches) return [];

    return Array.from(new Set(matches));
}

function isBadEmailUrl(value) {
    const text = String(value ?? "").trim();

    return text.startsWith("https://投递邮箱") ||
        text.startsWith("http://投递邮箱") ||
        text.includes("投递邮箱：") ||
        text.includes("投递邮箱:") ||
        text.includes("@");
}

/**
 * 读取飞书时做兜底修复：
 *
 * 旧数据可能已经被写成：
 * url: https://投递邮箱：hdslaw@126.com
 * applyText: 查看公告/投递方式
 *
 * 这里把它恢复成：
 * url: ""
 * applyText: 投递邮箱：hdslaw@126.com
 * applyType: email
 */
function repairApplyInfo(applyField) {
    const rawUrl = getUrl(applyField);
    const rawText = getApplyText(applyField);

    const combined = `${rawText} ${rawUrl}`;
    const emails = extractEmails(combined);

    if (emails.length > 0 && (isBadEmailUrl(rawUrl) || rawText === "查看公告/投递方式")) {
        return {
            url: "",
            applyUrl: "",
            applyText: `投递邮箱：${emails.join("; ")}`,
            applyType: "email"
        };
    }

    if (emails.length > 0) {
        return {
            url: rawUrl,
            applyUrl: rawUrl,
            applyText: rawText || `投递邮箱：${emails.join("; ")}`,
            applyType: "email"
        };
    }

    return {
        url: rawUrl,
        applyUrl: rawUrl,
        applyText: rawText,
        applyType: rawUrl ? "url" : "text"
    };
}

function getTag(value) {
    if (!value) return "";

    if (Array.isArray(value)) {
        const first = value[0];

        if (!first) return "";

        if (typeof first === "string") {
            return first;
        }

        if (typeof first === "object") {
            return first.text || first.name || first.value || "";
        }

        return String(first);
    }

    return getText(value, "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function getFeishuTenantToken() {
    const authRes = await fetchWithTimeout(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                app_id: process.env.FEISHU_APP_ID,
                app_secret: process.env.FEISHU_APP_SECRET
            })
        },
        15000
    );

    const authJson = await authRes.json();

    if (!authJson.tenant_access_token) {
        throw new Error(`飞书 Token 获取失败：${JSON.stringify(authJson)}`);
    }

    return authJson.tenant_access_token;
}

function buildJobs(items) {
    const jobs = items.map(item => {
        const fields = item.fields || {};
        const applyField = fields["投递链接"];
        const applyInfo = repairApplyInfo(applyField);

        return {
            companyName: getText(fields["公司名称"]),
            companyType: getText(fields["企业性质"]),
            content: getText(fields["招聘岗位"]),
            city: getText(fields["工作城市"]),
            industry: getText(fields["所属行业"]),

            // 真正可跳转链接
            url: applyInfo.url,

            // 给前端识别邮箱投递 / 查看公告 / 官方投递通道
            applyText: applyInfo.applyText,

            // 调试字段
            applyUrl: applyInfo.applyUrl,

            // url / email / text
            applyType: applyInfo.applyType,

            urgency: getText(fields["急招指数"]),
            noMajor: getText(fields["跨考友好"]),
            tag: getTag(fields["岗位标签"]),
            updateTime: fields["更新时间"],
            updateTimeMs: parseTime(fields["更新时间"]),
            sourceId: getText(fields["原数据ID"])
        };
    });

    jobs.sort((a, b) => {
        return parseTime(b.updateTime) - parseTime(a.updateTime);
    });

    return jobs;
}

/**
 * 关键优化：
 * 使用 records/search，让飞书服务端按「更新时间」降序排序。
 * 这样 fast 模式拿到的就是真正最新的记录。
 */
async function searchFeishuRecordsSortedByUpdateTime(tenantAccessToken, maxRecords) {
    let allItems = [];
    let pageToken = "";
    let loopCount = 0;
    let reachedEnd = false;

    while (allItems.length < maxRecords) {
        loopCount++;

        const pageSize = Math.min(500, maxRecords - allItems.length);

        const url =
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.FEISHU_APP_TOKEN}` +
            `/tables/${process.env.FEISHU_TABLE_ID}/records/search?page_size=${pageSize}` +
            (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");

        const searchRes = await fetchWithTimeout(
            url,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    field_names: [
                        "公司名称",
                        "企业性质",
                        "招聘岗位",
                        "工作城市",
                        "所属行业",
                        "投递链接",
                        "急招指数",
                        "跨考友好",
                        "岗位标签",
                        "更新时间",
                        "原数据ID"
                    ],
                    sort: [
                        {
                            field_name: "更新时间",
                            desc: true
                        }
                    ]
                })
            },
            20000
        );

        const searchJson = await searchRes.json();

        if (searchJson.code !== 0) {
            throw new Error(`按更新时间倒序查询飞书记录失败：${JSON.stringify(searchJson)}`);
        }

        const items = searchJson.data?.items || [];
        allItems = allItems.concat(items);

        const hasMore = Boolean(searchJson.data?.has_more && searchJson.data?.page_token);

        if (!hasMore) {
            reachedEnd = true;
            break;
        }

        pageToken = searchJson.data.page_token;

        if (loopCount > 1000) {
            reachedEnd = false;
            break;
        }
    }

    return {
        items: allItems.slice(0, maxRecords),
        reachedEnd
    };
}

async function getCachedJobs(cacheKey, loader, forceRefresh = false) {
    const cache = getCacheEntry(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cache.data && cache.expiresAt > now) {
        return {
            ...cache.data,
            cacheHit: true
        };
    }

    if (!forceRefresh && cache.loadingPromise) {
        const data = await cache.loadingPromise;
        return {
            ...data,
            cacheHit: true
        };
    }

    cache.loadingPromise = loader()
        .then(data => {
            cache.data = data;
            cache.expiresAt = Date.now() + CACHE_TTL_MS;
            return data;
        })
        .finally(() => {
            cache.loadingPromise = null;
        });

    const data = await cache.loadingPromise;

    return {
        ...data,
        cacheHit: false
    };
}

async function loadJobsSorted(maxRecords) {
    const tenantAccessToken = await getFeishuTenantToken();

    const { items, reachedEnd } = await searchFeishuRecordsSortedByUpdateTime(
        tenantAccessToken,
        maxRecords
    );

    const jobs = buildJobs(items);

    return {
        jobs,
        reachedEnd,
        loadedRecords: items.length
    };
}

module.exports = async function(req, res) {
    try {
        checkEnv();

        const urlObj = new URL(req.url, `https://${req.headers.host || "localhost"}`);

        // mode=fast：最新 200 条
        // mode=full：加载更多数据用于筛选
        const mode = urlObj.searchParams.get("mode") || "fast";

        const forceRefresh =
            urlObj.searchParams.get("refresh") === "1" ||
            urlObj.searchParams.get("noCache") === "1";

        const fastLimit = Math.max(
            1,
            Math.min(Number(urlObj.searchParams.get("fastLimit") || 200), 1000)
        );

        const fullLimit = Math.max(
            1,
            Math.min(Number(urlObj.searchParams.get("fullLimit") || 5000), 10000)
        );

        const legacyLimit = urlObj.searchParams.get("limit");

        // 兼容旧调用：/api/jobs?limit=500
        if (legacyLimit) {
            const limit = Math.max(
                1,
                Math.min(Number(legacyLimit || 200), 10000)
            );

            const cacheKey = limit <= 1000
                ? `fast-sorted:${limit}`
                : `full-sorted:${limit}`;

            const data = await getCachedJobs(
                cacheKey,
                () => loadJobsSorted(limit),
                forceRefresh
            );

            const result = data.jobs.slice(0, limit);

            return res.status(200).json({
                data: result,
                total: data.jobs.length,
                returned: result.length,
                mode: limit <= 1000 ? "fast-feishu-sorted" : "full-feishu-sorted",
                isFullData: data.reachedEnd,
                loadedRecords: data.loadedRecords,
                cacheHit: data.cacheHit,
                limit,
                sortedBy: "更新时间 desc"
            });
        }

        if (mode === "full") {
            const cacheKey = `full-sorted:${fullLimit}`;

            const data = await getCachedJobs(
                cacheKey,
                () => loadJobsSorted(fullLimit),
                forceRefresh
            );

            return res.status(200).json({
                data: data.jobs,
                total: data.jobs.length,
                returned: data.jobs.length,
                mode: "full-feishu-sorted",
                isFullData: data.reachedEnd,
                loadedRecords: data.loadedRecords,
                cacheHit: data.cacheHit,
                limit: fullLimit,
                sortedBy: "更新时间 desc"
            });
        }

        const fastCacheKey = `fast-sorted:${fastLimit}`;

        const data = await getCachedJobs(
            fastCacheKey,
            () => loadJobsSorted(fastLimit),
            forceRefresh
        );

        const result = data.jobs.slice(0, fastLimit);

        return res.status(200).json({
            data: result,
            total: data.jobs.length,
            returned: result.length,
            mode: "fast-feishu-sorted",
            isFullData: data.reachedEnd,
            loadedRecords: data.loadedRecords,
            cacheHit: data.cacheHit,
            limit: fastLimit,
            sortedBy: "更新时间 desc"
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.name === "AbortError" ? "请求超时，已主动中断" : err.message,
            stack: err.stack
        });
    }
};
