// api/sync.js

const SOURCE_URL =
    "https://backservice.offerxiansheng.com/api/backend-service/bkd/campus-recruit/pc/campus-signboard";

const agnosticKeywords = [
    "销售",
    "商务",
    "BD",
    "客户",
    "渠道",
    "运营",
    "新媒体",
    "主播",
    "市场",
    "品牌",
    "公关",
    "策划",
    "管培生",
    "储备干部",
    "人事",
    "人力资源",
    "行政",
    "助理"
];

const strictKeywords = [
    "研发",
    "算法",
    "工程师",
    "C++",
    "Java",
    "财务",
    "法务",
    "审计",
    "技术管培",
    "开发",
    "运维",
    "测试",
    "前端",
    "后端",
    "数据分析"
];

function formatDateTime(date = new Date()) {
    const bjDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, "0");

    return `${bjDate.getUTCFullYear()}-${pad(bjDate.getUTCMonth() + 1)}-${pad(bjDate.getUTCDate())} ${pad(bjDate.getUTCHours())}:${pad(bjDate.getUTCMinutes())}:${pad(bjDate.getUTCSeconds())}`;
}

function formatBeijingEndOfDay(date = new Date()) {
    const bjDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, "0");

    return `${bjDate.getUTCFullYear()}-${pad(bjDate.getUTCMonth() + 1)}-${pad(bjDate.getUTCDate())} 23:59:59`;
}

function safeString(value, fallback = "") {
    if (value === undefined || value === null) return fallback;

    if (Array.isArray(value)) {
        return value
            .map(item => safeString(item, ""))
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

function parseUpdateTime(updateTime) {
    if (!updateTime) return null;

    if (typeof updateTime === "number") {
        return updateTime;
    }

    const str = String(updateTime).trim();
    if (!str) return null;

    const match = str.match(
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
    );

    if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4] || 0);
        const minute = Number(match[5] || 0);
        const second = Number(match[6] || 0);

        // 源站时间按北京时间处理
        return Date.UTC(year, month - 1, day, hour - 8, minute, second);
    }

    const ms = new Date(str.replace(/-/g, "/")).getTime();

    if (Number.isNaN(ms)) {
        return null;
    }

    return ms;
}

function formatDateOnly(ms) {
    if (!ms) return "";

    const bjDate = new Date(ms + 8 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, "0");

    return `${bjDate.getUTCFullYear()}-${pad(bjDate.getUTCMonth() + 1)}-${pad(bjDate.getUTCDate())}`;
}

function isHttpUrl(value) {
    const text = safeString(value, "").trim();
    return text.startsWith("http://") || text.startsWith("https://");
}

function extractFirstHttpUrl(value) {
    const text = safeString(value, "").trim();
    if (!text) return "";

    const match = text.match(/https?:\/\/[^\s，,；;]+/i);
    return match ? match[0] : "";
}

function extractEmails(value) {
    const text = safeString(value, "");
    const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);

    if (!matches) return [];

    return Array.from(new Set(matches));
}

function hasChinese(value) {
    return /[\u4e00-\u9fa5]/.test(String(value || ""));
}

function normalizeHttpUrl(value) {
    const text = safeString(value, "").trim();

    if (!text) return "";

    const extracted = extractFirstHttpUrl(text);
    if (extracted) {
        return extracted;
    }

    // 避免把邮箱、中文说明、"投递邮箱：xxx@xxx.com" 当网址
    if (
        text.includes("@") ||
        hasChinese(text) ||
        /\s/.test(text)
    ) {
        return "";
    }

    const domainLike = /^(www\.)?[a-zA-Z0-9.-]+\.(com|cn|net|org|io|ai|edu|gov|co|top|xyz|cc|me)(\/.*)?$/i;

    if (domainLike.test(text)) {
        return `https://${text}`;
    }

    return "";
}

function pickApplyUrl(item) {
    const candidates = [
        item.url,
        item.announcementUrl
    ];

    for (const value of candidates) {
        const url = normalizeHttpUrl(value);
        if (url) return url;
    }

    return "https://m.baidu.com";
}

function getApplyField(item) {
    const rawApplyText = safeString(item.url, "").trim();
    const rawApplyUrl = normalizeHttpUrl(item.url);
    const announcementUrl = normalizeHttpUrl(item.announcementUrl);
    const emails = extractEmails(rawApplyText);

    let applyText = "查看公告/投递方式";
    let applyLink = rawApplyUrl || announcementUrl || "https://m.baidu.com";

    if (rawApplyUrl) {
        applyText = "官方投递通道";
    } else if (emails.length > 0) {
        // 保留邮箱原文
        applyText = rawApplyText;
    } else if (rawApplyText) {
        applyText = rawApplyText;
    } else if (announcementUrl) {
        applyText = "查看公告/投递方式";
    }

    return {
        text: applyText,
        link: applyLink,
        rawText: rawApplyText,
        rawUrl: rawApplyUrl,
        announcementUrl
    };
}

function getUrgency(updateTime) {
    const updateMs = parseUpdateTime(updateTime);
    if (!updateMs) return "";

    const diffDays = (Date.now() - updateMs) / (1000 * 60 * 60 * 24);

    if (diffDays <= 3) return "🔥🔥🔥 极急招";
    if (diffDays <= 7) return "🔥🔥 较急招";

    return "";
}

function getNoMajorTag(content) {
    const text = safeString(content, "");

    const hasStrict = strictKeywords.some(k => text.includes(k));
    const hasAgnostic = agnosticKeywords.some(k => text.includes(k));

    if (!hasStrict && hasAgnostic) {
        return "🌟 不限专业";
    }

    return "";
}

function getCity(item) {
    if (Array.isArray(item.cityNameList)) {
        return item.cityNameList.filter(Boolean).join(", ") || "全国";
    }

    return safeString(item.cityNameList, "全国");
}

function getSourceRecordId(item) {
    return String(
        item.id ||
        item.recruitId ||
        item.campusRecruitId ||
        `${item.companyName || "unknown"}-${item.content || "unknown"}-${item.updateTime || "unknown"}`
    );
}

function checkEnv() {
    const required = [
        "SOURCE_API_TOKEN",
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "FEISHU_APP_TOKEN",
        "FEISHU_TABLE_ID",
        "CRON_SECRET"
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`Vercel 环境变量缺失：${missing.join(", ")}`);
    }
}

function checkSyncSecret(req, urlObj) {
    const authHeader = req.headers.authorization || req.headers.Authorization || "";
    const querySecret = urlObj.searchParams.get("secret") || "";

    const expectedHeader = `Bearer ${process.env.CRON_SECRET}`;

    const validByHeader = authHeader === expectedHeader;
    const validByQuery = querySecret && querySecret === process.env.CRON_SECRET;

    return Boolean(validByHeader || validByQuery);
}

function getPageDateSummary(records) {
    const times = records
        .map(item => parseUpdateTime(item.updateTime))
        .filter(Boolean)
        .sort((a, b) => a - b);

    if (times.length === 0) {
        return {
            minUpdateTime: "",
            maxUpdateTime: ""
        };
    }

    return {
        minUpdateTime: formatDateOnly(times[0]),
        maxUpdateTime: formatDateOnly(times[times.length - 1])
    };
}

function getFilterRange(urlObj, mode) {
    const fromDate = urlObj.searchParams.get("fromDate");
    const toDate = urlObj.searchParams.get("toDate");

    if (fromDate) {
        const startMs = parseUpdateTime(`${fromDate} 00:00:00`);
        const endMs = toDate
            ? parseUpdateTime(`${toDate} 23:59:59`)
            : Date.now();

        return {
            startMs,
            endMs,
            days: null,
            fromDate: formatDateOnly(startMs),
            toDate: formatDateOnly(endMs)
        };
    }

    const defaultDays = mode === "backfill" ? 180 : 7;

    const days = Math.max(
        1,
        Math.min(Number(urlObj.searchParams.get("days") || defaultDays), 365)
    );

    const startMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const endMs = Date.now();

    return {
        startMs,
        endMs,
        days,
        fromDate: formatDateOnly(startMs),
        toDate: formatDateOnly(endMs)
    };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
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

async function fetchSourcePage(pageIndex = 0, options = {}) {
    const realPage = pageIndex + 1;

    const payload = {
        page: realPage,
        size: options.size || 20,
        lastTime: options.lastTime,
        companyName: "",
        recruitBusinessId: "",
        cityIdList: "0",
        posInfoId: "",
        domesticGraduationDate: "",
        overseasGraduationDate: "",
        educationList: null,
        companyType: "",
        endTime: null,
        progress: "",
        tag: ""
    };

    const headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Content-Type": "application/json",
        "Access-Token": process.env.SOURCE_API_TOKEN,
        "Source": "2",
        "Origin": "https://www.offerxiansheng.com",
        "Referer": "https://www.offerxiansheng.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    };

    if (process.env.SOURCE_COOKIE) {
        headers.Cookie = process.env.SOURCE_COOKIE;
    }

    const sourceRes = await fetchWithTimeout(
        SOURCE_URL,
        {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        },
        15000
    );

    const text = await sourceRes.text();

    let sourceJson;
    try {
        sourceJson = JSON.parse(text);
    } catch (err) {
        throw new Error(
            `原站返回的不是 JSON。HTTP ${sourceRes.status}，内容片段：${text.slice(0, 300)}`
        );
    }

    if (!sourceRes.ok) {
        throw new Error(
            `原站 HTTP 请求失败。HTTP ${sourceRes.status}，返回：${JSON.stringify(sourceJson).slice(0, 500)}`
        );
    }

    const records = sourceJson.data?.records;

    if (!Array.isArray(records)) {
        throw new Error(
            `原站返回结构异常，没有 data.records。返回：${JSON.stringify(sourceJson).slice(0, 500)}`
        );
    }

    return {
        pageIndex,
        realPage,
        payload,
        records,
        raw: sourceJson
    };
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
        throw new Error(
            `飞书 tenant_access_token 获取失败：${JSON.stringify(authJson)}`
        );
    }

    return authJson.tenant_access_token;
}

function buildFeishuRecord(item) {
    const content = safeString(item.content, "未知岗位");
    const updateMs = parseUpdateTime(item.updateTime) || Date.now();
    const applyField = getApplyField(item);

    return {
        fields: {
            "公司名称": safeString(item.companyName, "未知公司"),
            "企业性质": safeString(item.companyType, "其他"),
            "招聘岗位": content,
            "工作城市": getCity(item),
            "所属行业": safeString(item.recruitBusinessName, "不限"),
            "投递链接": {
                text: applyField.text,
                link: applyField.link
            },
            "更新时间": updateMs,
            "原数据ID": getSourceRecordId(item),
            "急招指数": getUrgency(item.updateTime),
            "跨考友好": getNoMajorTag(content),
            "岗位标签": item.tag ? [String(item.tag)] : []
        }
    };
}

function chunkArray(arr, size) {
    const result = [];

    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }

    return result;
}

function normalizeFeishuFieldValue(value) {
    if (value === undefined || value === null) return "";

    if (Array.isArray(value)) {
        return value.map(normalizeFeishuFieldValue).join("");
    }

    if (typeof value === "object") {
        return String(
            value.text ||
            value.name ||
            value.value ||
            value.link ||
            ""
        );
    }

    return String(value);
}

/**
 * 只检查本次抓到的原数据ID是否已存在
 * 不再全表扫描飞书
 */
async function getExistingSourceIdsBySourceIds(tenantAccessToken, sourceIds) {
    const existingIds = new Set();

    const cleanIds = Array.from(
        new Set(
            sourceIds
                .map(id => String(id || "").trim())
                .filter(Boolean)
        )
    );

    if (cleanIds.length === 0) {
        return existingIds;
    }

    const url =
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.FEISHU_APP_TOKEN}` +
        `/tables/${process.env.FEISHU_TABLE_ID}/records/search?page_size=500`;

    const idBatches = chunkArray(cleanIds, 50);

    for (const batch of idBatches) {
        const searchRes = await fetchWithTimeout(
            url,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    field_names: ["原数据ID"],
                    filter: {
                        conjunction: "or",
                        conditions: batch.map(id => ({
                            field_name: "原数据ID",
                            operator: "is",
                            value: [id]
                        }))
                    }
                })
            },
            15000
        );

        const searchJson = await searchRes.json();

        if (searchJson.code !== 0) {
            throw new Error(`按原数据ID查询飞书记录失败：${JSON.stringify(searchJson)}`);
        }

        const items = searchJson.data?.items || [];

        for (const item of items) {
            const sourceId = normalizeFeishuFieldValue(item.fields?.["原数据ID"]).trim();

            if (sourceId) {
                existingIds.add(sourceId);
            }
        }
    }

    return existingIds;
}

async function writeFeishuRecords(records, tenantAccessToken) {
    const url =
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${process.env.FEISHU_APP_TOKEN}` +
        `/tables/${process.env.FEISHU_TABLE_ID}/records/batch_create`;

    const chunks = chunkArray(records, 200);
    const results = [];

    for (const chunk of chunks) {
        const writeRes = await fetchWithTimeout(
            url,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    records: chunk
                })
            },
            20000
        );

        const writeJson = await writeRes.json();

        if (writeJson.code !== 0) {
            throw new Error(
                `飞书写入失败，通常是字段名不匹配或字段类型不对：${JSON.stringify(writeJson)}`
            );
        }

        results.push(writeJson);
    }

    return results;
}

module.exports = async function(req, res) {
    try {
        checkEnv();

        const urlObj = new URL(req.url, `https://${req.headers.host || "localhost"}`);

        if (!checkSyncSecret(req, urlObj)) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const mode = urlObj.searchParams.get("mode") || "daily";
        const range = getFilterRange(urlObj, mode);

        const startPage = Math.max(
            0,
            Number(urlObj.searchParams.get("startPage") || 0)
        );

        const defaultPages = mode === "backfill" ? 20 : 20;

        const pages = Math.max(
            1,
            Math.min(Number(urlObj.searchParams.get("pages") || defaultPages), 50)
        );

        const pageSize = Math.max(
            1,
            Math.min(Number(urlObj.searchParams.get("size") || 20), 100)
        );

        const dryRun = urlObj.searchParams.get("dryRun") === "1";

        const sourceLastTime =
            urlObj.searchParams.get("lastTime") ||
            process.env.SOURCE_LAST_TIME ||
            formatBeijingEndOfDay();

        let allSourceRecords = [];
        let matchedRecords = [];
        const pageSummaries = [];

        for (let offset = 0; offset < pages; offset++) {
            const pageIndex = startPage + offset;

            const { records, raw, payload, realPage } = await fetchSourcePage(pageIndex, {
                lastTime: sourceLastTime,
                size: pageSize
            });

            const matchedInPage = records.filter(item => {
                const updateMs = parseUpdateTime(item.updateTime);
                return updateMs && updateMs >= range.startMs && updateMs <= range.endMs;
            });

            const dateSummary = getPageDateSummary(records);

            pageSummaries.push({
                pageIndex,
                realPage,
                requestPayload: payload,
                sourceCount: records.length,
                matchedCount: matchedInPage.length,
                minUpdateTime: dateSummary.minUpdateTime,
                maxUpdateTime: dateSummary.maxUpdateTime,
                code: raw.code,
                message: raw.message || raw.msg || "",
                apiTotal: raw.data?.total || raw.data?.count || null
            });

            allSourceRecords = allSourceRecords.concat(records);
            matchedRecords = matchedRecords.concat(matchedInPage);

            if (records.length === 0) {
                break;
            }

            // daily 模式下，如果这一页最新的数据都早于 fromDate，后面页只会更旧，可提前停止
            if (
                mode !== "backfill" &&
                range.fromDate &&
                dateSummary.maxUpdateTime &&
                dateSummary.maxUpdateTime < range.fromDate
            ) {
                break;
            }
        }

        const uniqueMap = new Map();

        for (const item of matchedRecords) {
            const id = getSourceRecordId(item);
            if (!uniqueMap.has(id)) {
                uniqueMap.set(id, item);
            }
        }

        const uniqueMatchedRecords = Array.from(uniqueMap.values());

        const commonResponse = {
            success: true,
            mode,
            dryRun,
            days: range.days,
            fromDate: range.fromDate,
            toDate: range.toDate,
            startPage,
            pages,
            pageSize,
            sourceLastTime,
            sourceTotal: allSourceRecords.length,
            matchedTotal: matchedRecords.length,
            uniqueMatchedTotal: uniqueMatchedRecords.length,
            pageSummaries,
            tokenCheck: {
                length: process.env.SOURCE_API_TOKEN?.length || 0,
                start: process.env.SOURCE_API_TOKEN?.slice(0, 4) || "",
                end: process.env.SOURCE_API_TOKEN?.slice(-4) || ""
            },
            matchedSample: uniqueMatchedRecords.slice(0, 5).map(item => {
                const applyField = getApplyField(item);

                return {
                    id: getSourceRecordId(item),
                    companyName: item.companyName,
                    content: item.content,
                    updateTime: item.updateTime,
                    beginTime: item.beginTime,
                    endTime: item.endTime,
                    tag: item.tag,
                    url: item.url,
                    announcementUrl: item.announcementUrl,
                    applyText: applyField.text,
                    applyLink: applyField.link
                };
            }),
            sourceSample: allSourceRecords.slice(0, 5).map(item => {
                const applyField = getApplyField(item);

                return {
                    id: getSourceRecordId(item),
                    companyName: item.companyName,
                    content: item.content,
                    updateTime: item.updateTime,
                    beginTime: item.beginTime,
                    endTime: item.endTime,
                    tag: item.tag,
                    url: item.url,
                    announcementUrl: item.announcementUrl,
                    applyText: applyField.text,
                    applyLink: applyField.link
                };
            })
        };

        if (dryRun) {
            return res.status(200).json(commonResponse);
        }

        if (uniqueMatchedRecords.length === 0) {
            return res.status(200).json({
                ...commonResponse,
                message: "源站请求成功，但没有匹配到日期范围内的数据，没有写入飞书"
            });
        }

        const tenantAccessToken = await getFeishuTenantToken();

        const existingIds = await getExistingSourceIdsBySourceIds(
            tenantAccessToken,
            uniqueMatchedRecords.map(getSourceRecordId)
        );

        const recordsToCreate = uniqueMatchedRecords.filter(item => {
            const id = getSourceRecordId(item);
            return !existingIds.has(id);
        });

        if (recordsToCreate.length === 0) {
            return res.status(200).json({
                ...commonResponse,
                message: "匹配到数据，但飞书里已经存在，没有新增写入",
                insertedCount: 0,
                skippedDuplicateCount: uniqueMatchedRecords.length,
                existingCheckMode: "targeted_search",
                checkedSourceIdCount: uniqueMatchedRecords.length,
                existingIdCount: existingIds.size
            });
        }

        const recordsToCreateSorted = recordsToCreate.sort((a, b) => {
            return (parseUpdateTime(b.updateTime) || 0) - (parseUpdateTime(a.updateTime) || 0);
        });

        const feishuRecords = recordsToCreateSorted.map(buildFeishuRecord);

        const feishuResults = await writeFeishuRecords(
            feishuRecords,
            tenantAccessToken
        );

        return res.status(200).json({
            ...commonResponse,
            message: mode === "backfill" ? "历史回填成功" : "每日同步成功",
            insertedCount: feishuRecords.length,
            skippedDuplicateCount: uniqueMatchedRecords.length - feishuRecords.length,
            existingCheckMode: "targeted_search",
            checkedSourceIdCount: uniqueMatchedRecords.length,
            existingIdCount: existingIds.size,
            sampleWritten: feishuRecords.slice(0, 3),
            feishuResponseCount: feishuResults.length
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "同步失败",
            error: err.name === "AbortError" ? "请求超时，已主动中断" : err.message,
            stack: err.stack
        });
    }
};
