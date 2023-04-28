import BaseClient, { BaseClientOptions }     from "./BaseClient"
import { assert, getPrefixedFileName, wait } from "./utils"
import { ExportManifest }                    from "./types"
import { format }                            from "util"
import { createWriteStream }                 from "fs"


interface BulkDataClientOptions extends BaseClientOptions {
    groupId: string
    retryAfterMSec: number
}

const MIN_POOL_DELAY = 100 // 100ms
const MAX_POOL_DELAY = 1000 * 60 * 60 // 1 hour


export default class BulkDataClient extends BaseClient
{
    protected options: BulkDataClientOptions

    constructor(options: BulkDataClientOptions) {
        super(options)
    }

    public async kickOff(): Promise<string> {
        const url = `Group/${this.options.groupId}/$export?_type=Patient`
        const { response } = await this.request(url, {
            headers: {
                prefer: "respond-async",
                accept: "application/fhir+json"
            }
        })
        const location = response.headers.get("content-location")
        assert(location, "The kick-off response did not include content-location header")
        return location
    }

    public async waitForExport(statusEndpoint: string, onProgress?: (status: string) => void): Promise<ExportManifest>
    {
        const { response, body } = await this.request(statusEndpoint, { headers: { accept: "application/json" }})

        if (response.status == 200) {
            return body
        }

        if (response.status == 202) {
            const retryAfter  = String(response.headers.get("retry-after") || "").trim();

            let retryAfterMSec = this.options.retryAfterMSec;
            if (retryAfter) {
                if (retryAfter.match(/\d+/)) {
                    retryAfterMSec = parseInt(retryAfter, 10) * 1000
                } else {
                    let d = new Date(retryAfter);
                    retryAfterMSec = Math.ceil(d.getTime() - Date.now())
                }
            }

            const poolDelay = Math.min(Math.max(retryAfterMSec, MIN_POOL_DELAY), MAX_POOL_DELAY)
            onProgress && onProgress(String(response.headers.get("X-Progress") || "working..."))
            await wait(poolDelay)
            return this.waitForExport(statusEndpoint, onProgress)
        }

        throw new Error(format("Unexpected bulk status response %s %s. Body: %j", response.status, response.statusText, body))
    }

    async download(manifest: ExportManifest, destination: string) {
        const files: string[] = [];
        for (const entry of manifest.output) {
            const { url, type } = entry
            const dst = getPrefixedFileName(destination, type + ".ndjson", this.options.maxFileSize)
            await this.downloadFile(url, dst, manifest.requiresAccessToken)
            files.push(dst)
        }
        return files
    }
    
    async downloadFile(url: string, path: string, authorize = true) {
        const headers: any = {
            accept: "application/fhir+ndjson",
            "accept-encoding": "gzip, deflate, br, identity"
        }
        if (!authorize) {
            headers.authorization = undefined // Disables authorization
        }
        const response = await this.request(url, { headers }, true);
        assert(response.body, "No response body")
        const fileStream = createWriteStream(path);
        await new Promise((resolve, reject) => {
            response.body!.pipe (fileStream);
            response.body!.on("error", reject);
            fileStream.on ("finish", resolve);
        });
    }
}
