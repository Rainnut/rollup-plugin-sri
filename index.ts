import { Element, load } from 'cheerio'
import { Plugin, ResolvedConfig } from 'vite'
// import fetch from 'node:node-fetch'
import { writeFileSync, readFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { resolve } from 'path'
import { OutputBundle } from 'rollup'

export default function sri(): Plugin {
  // rollup.config 必须填options，vite自动获取options
  let config: ResolvedConfig
  const bundle: OutputBundle = {}

  return {
    name: 'rollup-plugin-sri',
    // vite 才会调用configResolved初始化配置
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    // enforce: 'post',
    // apply: 'build',
    async writeBundle(writeBundleOptions, _bundle) {
      // when use with vite-plugin-legacy
      // writeBundle 调用俩次
      // legacy bundle will be run first, but not with index.html file
      // esm bundle will be run after, so should saved legacy bundle before esm bundle output.
      Object.entries(_bundle).forEach(([k, v]) => {
        // @ts-ignore
        bundle[k] = v
      })

      const htmls = Object.keys(bundle)
        .filter((filename) => filename.endsWith('.html'))
        // @ts-ignore
        .map((filename) => {
          const bundleItem = bundle[filename]
          if (bundleItem.type === 'asset') {
            return {
              name: bundleItem.fileName,
              source: bundleItem.source,
            }
          }
        })
        .filter((item) => !!item) as Array<{
        name: string
        source: string
      }>

      htmls.forEach(async ({ name, source: html }) => {
        // @ts-ignore
        const $ = load(html as string)

        // 给 scripts、stylesheets 标签添加 SRI
        const scripts = $('script').filter('[src]')
        const stylesheets = $('link').filter('[href]')

        const calculateIntegrityHashes = async (element: Element) => {
          let source: string | Uint8Array | undefined
          const attributeName = element.attribs.src ? 'src' : 'href'
          const resourceUrl = element.attribs[attributeName]

          const resourcePath =
            resourceUrl.indexOf(config.base) === 0
              ? resourceUrl.substring(config.base.length)
              : resourceUrl

          const t = Object.entries(bundle).find(
            ([, bundleItem]) => bundleItem.fileName === resourcePath
          )?.[1]

          if (!t) {
            const logger = config.logger || this
            logger.warn(`cannot find ${resourcePath} in output bundle.`)
            try {
              source = readFileSync(
                resolve(writeBundleOptions.dir as string, resourcePath)
              )
            } catch (error) {
              source = void 0
            }
          } else {
            if (t.type === 'asset') {
              source = t.source
            } else {
              source = t.code
            }
          }

          if (source)
            element.attribs.integrity = `sha384-${createHash('sha384')
              .update(source)
              .digest()
              .toString('base64')}`

          if (element.attribs.integrity && !element.attribs.crossorigin) {
            // 在进行跨域资源请求时，integrity必须配合crossorigin使用，不然浏览器会丢弃这个资源的请求
            // https://developer.mozilla.org/zh-CN/docs/Web/HTML/Attributes/crossorigin
            element.attribs.crossorigin = 'anonymous'
          }
        }

        await Promise.all([
          ...scripts.map(async (i, script) => {
            return await calculateIntegrityHashes(script)
          }),
          ...stylesheets.map(async (i, style) => {
            return await calculateIntegrityHashes(style)
          }),
        ])

        writeFileSync(
          resolve(process.cwd(), config?.build.outDir as string, name),
          $.html()
        )
      })
    },
  }
}
