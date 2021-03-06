const fs = require('fs');
const path = require('path');
const { fetch } = require('fetch-h2');
const ShopifyAPI = require('./shopify-api');
const {getFiles, md5File} = require('./utils');

class Shopify {
    constructor(auth) {
        this.shopifyAPI = new ShopifyAPI(auth);
    }

    async #getThemeID(name = null) {
        const res = await this.shopifyAPI.getThemes();

        //TODO: normalize name?
        return res.themes.filter(t => (!name && t.role === 'main') || t.name === name)[0];
    }

    async #saveFile(filename, data) {
        const ensureDirectoryExistence = function (filePath) {
            let dirname = path.dirname(filePath);
            if (fs.existsSync(dirname)) {
                return true;
            }
            ensureDirectoryExistence(dirname);
            fs.mkdirSync(dirname);
        };

        return new Promise((resolve, reject) => {
            ensureDirectoryExistence(filename);
            fs.writeFile(filename, data, error => error ? reject(error) : resolve(data))
        })
    }

    #readFile(filename) {
        return fs.readFileSync(filename, "utf-8");
    }

    async list() {
        return this.shopifyAPI.getThemes();
    }

    async publishTheme(themeName) {
        if (!themeName) return;

        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return;
        if (theme.role !== 'main') return;

        console.log(`PUBLISHING: ${theme.name}`);
        await this.shopifyAPI.updateTheme(theme.id, theme.name, 'main')
    }

    async initTheme(themeName, src = null) {
        if (!themeName) return;

        const theme = await this.#getThemeID(themeName);
        if (theme) return;

        console.log(`CREATE Theme: ${themeName}`);
        await this.shopifyAPI.createTheme(themeName, 'unpublished', src)
    }

    async #getAssets(themeID) {
        const data = await this.shopifyAPI.getAssets(themeID)
        const assetsMap = new Map(data.assets.map(a => [a.key, a]));
        for (const key of assetsMap.keys()) {
            if (assetsMap.has(key + ".liquid")) {
                assetsMap.delete(key);
            }
        }
        return [...assetsMap.values()];
    }


    async pullAssets(themeName = null, destDir = "./shopify", save = true, force = false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const assets = await this.#getAssets(theme.id);
        if (save) {
            await Promise.all(assets.map(async asset => {
                const filename = path.join(destDir, asset.key);

                // API optimization
                if (!force && fs.existsSync(filename)) {
                    //skip if the checksums aren't any different from remote and local files
                    if (asset.checksum && asset.checksum === await md5File(filename)) {
                        console.debug(`SKIP: ${filename}`);
                        return;
                    }
                    //skip if the local file has the same byte size and the modified date locally is > the remote update date
                    const stats = fs.statSync(filename);
                    if (stats.size === asset.size && stats.mtime.getTime() >= Date.parse(asset.updated_at)) {
                        console.debug(`SKIP: ${filename}`);
                        return;
                    }
                }

                console.log(`SAVING: ${asset.key}`)
                if (asset.public_url) {
                    const res = await fetch(asset.public_url);
                    await this.#saveFile(path.join(destDir, asset.key), Buffer.from(await res.arrayBuffer()));
                }
                else {
                    const detail = await this.shopifyAPI.getAsset(theme.id, asset.key);
                    if (detail && detail.asset && detail.asset.value) {
                        await this.#saveFile(filename, detail.asset.value.replace(/\\\//g, "/"));
                    }
                }

                //TODO: delete local

            }))
        }
        return assets;
    }

    async pushAssets(themeName = null, destDir = "./shopify", force = false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const assets = await this.#getAssets(theme.id);
        // start with the known set of base dirs to innumerate, but future proof a bit by probing for new dirs
        const knownDirs = new Set(["assets","layout","sections","templates","config","locales","snippets"]);
        assets.map(a => a.key.replace(/\/.*/, "")).forEach(knownDirs.add, knownDirs);

        const localFiles = new Set();
        for (const baseDir of knownDirs) {
            for await (const file of getFiles(path.join(destDir, baseDir))) {
                localFiles.add(path.relative(destDir, file));
            }
        }

        const deletePaths = new Set();

        // this loop inspection is opposite the other ones. should iterate over the local files not the remote files
        for (const asset of assets) {
            const filename = path.join(destDir, asset.key);

            if (localFiles.has(asset.key)) {
                // API optimization
                if (!force && fs.existsSync(filename)) {
                    //skip if the checksums aren't any different from remote and local files
                    if (asset.checksum && asset.checksum === await md5File(filename)) {
                        localFiles.delete(asset.key);
                        continue;
                    }
                    //skip if the local file has the same byte size and the modified date locally is > the remote update date
                    const stats = fs.statSync(filename);
                    if (stats.size === asset.size && stats.mtime.getTime() >= Date.parse(asset.updated_at)) {
                        localFiles.delete(asset.key);
                        continue;
                    }
                }
            }
            else {
                localFiles.delete(asset.key);
                deletePaths.add(asset.key);
            }
        }

        // Create & Updates
        await Promise.all([...localFiles.values()].map(async key => {
            console.log(`UPDATE: ${key}`);
            //TODO: make this work for binary (use attachment)
            const data = this.#readFile(path.join(destDir, key));
            await this.shopifyAPI.updateAsset(theme.id, key, data);
        }));
        // Deletes
        await Promise.all([...deletePaths.values()].map(async key => {
            console.log(`DELETE: ${key}`)
            await this.shopifyAPI.deleteAsset(theme.id, key);
        }));

        return assets;
    }

    async getRedirects() {
        let count = null;
        const redirects = [];
        while (count === null || redirects.length < count) {
            const maxID = Math.max(0, ...redirects.map(r => r.id));
            const data = await this.shopifyAPI.getRedirects(maxID);
            redirects.push(...data.redirects);
            if (count === null) {
                count = redirects.length < 250 ? redirects.length : (await this.shopifyAPI.getRedirectsCount()).count;
            }
        }
        return redirects;
    }
    async pullRedirects(destDir = "./shopify") {
        const redirects = await this.getRedirects();
        const filename = path.join(destDir, "redirects.csv");
        const csvData = ["Redirect from,Redirect to"];
        //TODO: .replace(",", "%2C")
        csvData.push(...redirects.map(r => r.path + "," + r.target));
        await this.#saveFile(filename, csvData.join('\n'));
        return redirects;
    }

    async pushRedirects(destDir = "./shopify") {
        const data = await this.getRedirects();
        const originalPaths = new Map(data.map(r => [r.path, r]));

        const updatePaths = new Map();
        const createPaths = new Map();

        const filename = path.join(destDir, "redirects.csv");

        if (!fs.existsSync(filename)) {
            return;
        }

        const csvData = this.#readFile(filename).split(/[\n\r]+/);
        csvData.shift();
        for (const line of csvData) {
            if (!line || !line.startsWith('/')) continue; // skip empty lines or the first row;
            const [path, target] = line.split(',');
            if (!path || !target) continue;

            if (originalPaths.has(path)) {
                const detail = originalPaths.get(path);
                if (detail.target !== target) {
                    detail.target = target;
                    updatePaths.set(path, detail);
                }
                originalPaths.delete(path);
            }
            else {
                createPaths.set(path, {path, target});
            }
        }

        // Creates
        await Promise.all([...createPaths.values()].map(async r => {
            console.log(`CREATE 302: ${r.path} => ${r.target}`);
            await this.shopifyAPI.createRedirect(r.path, r.target);
        }));
        // Updates
        await Promise.all([...updatePaths.values()].map(async r => {
            console.log(`UPDATE 302: ${r.path} => ${r.target}`);
            await this.shopifyAPI.updateRedirect(r.id, r.path, r.target);
        }));
        // Deletes
        await Promise.all([...originalPaths.values()].map(async r => {
            console.log(`DELETE 302: ${r.path}`);
            await this.shopifyAPI.deleteRedirect(r.id);
        }));
        return csvData;
    }

    async getScriptTags() {
        let count = null;
        const scripts = [];
        while (count === null || scripts.length < count) {
            const maxID = Math.max(0, ...scripts.map(r => r.id));
            const data = await this.shopifyAPI.getScriptTags(maxID)
            scripts.push(...data.script_tags);
            if (count === null) count = scripts.length < 250 ? scripts.length : (await this.shopifyAPI.getScriptTagsCount()).count;
        }
        return scripts;
    }

    async pullScriptTags(destDir = "./shopify") {
        const scripts = await this.getScriptTags();
        const filename = path.join(destDir, "scripts.csv");
        const csvData = ["src,event,scope"];
        //TODO: .replace(",", "%2C")
        csvData.push(...scripts.map(s => s.src + "," + s.event + "," + s.display_scope));
        await this.#saveFile(filename, csvData.join('\n'));
        return scripts;
    }

    async pushScriptTags(destDir = "./shopify") {
        const data = await this.getScriptTags();
        const originalScripts = new Map(data.map(r => [r.src, r]));

        const updateScripts = new Map();
        const createScripts = new Map();

        const filename = path.join(destDir, "scripts.csv");

        if (!fs.existsSync(filename)) {
            return;
        }

        const csvData = this.#readFile(filename).split(/[\n\r]+/);
        csvData.shift();
        for (const line of csvData) {
            if (!line || !/\//.test(line)) continue; // skip empty lines or the first row;
            const [src,event,scope] = line.split(',');
            if (originalScripts.has(src)) {
                const detail = originalScripts.get(src);
                if (detail.event !== event || detail.display_scope !== scope) {
                    detail.event = event;
                    detail.display_scope = scope;
                    updateScripts.set(src, detail);
                }
                originalScripts.delete(src);
            }
            else {
                createScripts.set(src, {src: src, event: event, display_scope: scope});
            }
        }

        // Creates
        await Promise.all([...createScripts.values()].map(async s => {
            console.log(`CREATE ScriptTag: ${s.src} ${s.event} (${s.display_scope})`);
            await this.shopifyAPI.createScriptTags(s.src, s.target);
        }));
        // Updates
        await Promise.all([...updateScripts.values()].map(async s => {
            console.log(`UPDATE ScriptTag: ${s.src} ${s.event} (${s.display_scope})`);
            await this.shopifyAPI.updateScriptTags(s.id, s.src, s.event, s.display_scope);
        }));
        // Deletes
        await Promise.all([...originalScripts.values()].map(async s => {
            console.log(`DELETE ScriptTag: ${s.src}`);
            await this.shopifyAPI.deleteScriptTags(s.id);
        }));
        return csvData;
    }

    async getPages() {
        let count = null;
        const pages = [];
        while (count === null || pages.length < count) {
            const maxID = Math.max(0, ...pages.map(r => r.id));
            const data = await this.shopifyAPI.getPages(maxID)
            pages.push(...data.pages);
            if (count === null) count = pages.length < 250 ? pages.length : (await this.shopifyAPI.getPagesCount()).count;
        }
        return pages;
    }

    async pullPages(destDir = "./shopify") {
        const pagesDir = path.join(destDir, "pages");
        const pagesDraftDir = path.join(pagesDir, "drafts");

        const remotePages = await this.getPages();

        for (const page of remotePages) {
            const handle = page.handle;
            const html = page.body_html;
            const filename = path.join(page.published_at ? pagesDir : pagesDraftDir, handle);
            delete page.id;
            delete page.handle;
            delete page.shop_id;
            delete page.admin_graphql_api_id;
            page.body_html = {file: `${handle}.html`};
            console.log("SAVING: ${filename}.html");
            await this.#saveFile(filename + ".json", JSON.stringify(page, null, 2));
            await this.#saveFile(filename + ".html", html);
        }
        //TODO: delete
    }

    async pushPages(destDir = "./shopify") {
        const pagesDir = path.join(destDir, "pages");
        const pagesDraftDir = path.join(pagesDir, "drafts");

        const remotePages = await this.getPages();
        const readPageFile = (file) => {
            if (!fs.existsSync(file)) return;
            const d = this.#readFile(file);
            const data = JSON.parse(d);
            if (data.body_html && data.body_html.file) {
                data.body_html = this.#readFile(path.join(path.dirname(file), data.body_html.file));
            }
            return data;
        }

        const isSame = (a, b) => {
            const left = Object.assign({}, a);
            delete left.id;
            delete left.shop_id;
            delete left.admin_graphql_api_id;
            delete left.created_at;
            delete left.updated_at;
            delete left.published_at;

            const right = Object.assign({}, b);
            delete right.id;
            delete right.shop_id;
            delete right.admin_graphql_api_id;
            delete right.created_at;
            delete right.updated_at;
            delete right.published_at;

            return JSON.stringify(left, Object.keys(left).sort()) === JSON.stringify(right, Object.keys(right).sort());
        }

        const localFiles = new Set();
        for await (const file of getFiles(pagesDir)) {
            if (!file.endsWith(".json")) continue; // only look for the .json files (implying the .html files)
            localFiles.add(path.relative(pagesDir, file).replace(/\.json$/,""));
        }

        const updatePage = new Set();
        const deletePages = new Set();

        for (const page of remotePages) {
            const handle = page.handle;
            const draftHandle = path.join("drafts", handle);

            if (localFiles.has(handle) || localFiles.has(draftHandle)) {
                const detail = readPageFile(path.join(pagesDir, handle + ".json")) || readPageFile(path.join(pagesDraftDir, handle + ".json"));

                //if the file exists in both drafts and published, we bias to the published entry
                detail.published = !localFiles.has(draftHandle) || localFiles.has(handle);
                if (!detail.published) delete detail.published_at; // not enough just to say it is not published
                detail.handle = handle;
                detail.id = page.id;
                page.published = (!!page.published_at);

                if (!isSame(page, detail)) {
                    updatePage.add(detail);
                }
                localFiles.delete(handle);
                localFiles.delete(draftHandle);
            }
            else {
                deletePages.add(page);
            }
        }
        // Creates
        await Promise.all([...localFiles].map(async file => {
            const page = readPageFile(path.join(pagesDir, file + ".json"));
            page.published = file.startsWith("drafts");
            page.handle = file.replace("drafts/", "");
            console.log(`CREATE pages/${file}`);
            await this.shopifyAPI.createPage(page);
        }));
        // Updates
        await Promise.all([...updatePage].map(async file => {
            console.log(`UPDATE pages/${file.handle})`);
            await this.shopifyAPI.updatePage(file.id, file);
        }));
        // Deletes
        await Promise.all([...deletePages].map(async file => {
            console.log(`DELETE pages/${file.handle}`);
            await this.shopifyAPI.deletePage(file.id);
        }));
    }
}

module.exports = Shopify;
