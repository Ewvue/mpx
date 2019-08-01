const NodeTemplatePlugin = require('webpack/lib/node/NodeTemplatePlugin')
const NodeTargetPlugin = require('webpack/lib/node/NodeTargetPlugin')
const LibraryTemplatePlugin = require('webpack/lib/LibraryTemplatePlugin')
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin')

const hash = require('hash-sum')
const path = require('path')
const ConcatSource = require('webpack-sources').ConcatSource
const stripExtension = require('./utils/strip-extention')
const loaderUtils = require('loader-utils')
const config = require('./config')
const createHelpers = require('./helpers')
const InjectDependency = require('./dependency/InjectDependency')
const stringifyQuery = require('./utils/stringify-query')
const async = require('async')

const EXT_MPX_JSON = '.mpxjson.js';

module.exports = function (content) {
  this.cacheable()

  if (!this._compilation.__mpx__) {
    return content
  }

  const nativeCallback = this.async()

  const loaderContext = this
  const isProduction = this.minimize || process.env.NODE_ENV === 'production'
  const options = loaderUtils.getOptions(this) || {}

  const filePath = this.resourcePath

  const context = (
    this.rootContext ||
    (this.options && this.options.context) ||
    process.cwd()
  )
  const shortFilePath = path.relative(context, filePath).replace(/^(\.\.[\\/])+/, '')
  const moduleId = hash(isProduction ? (shortFilePath + '\n' + content) : shortFilePath)

  const needCssSourceMap = (
    !isProduction &&
    this.sourceMap &&
    options.cssSourceMap !== false
  )

  const hasScoped = false
  const hasComment = false
  const isNative = true

  const mainCompilation = this._compilation
  const projectRoot = this._compilation.__mpx__.projectRoot
  const mode = this._compilation.__mpx__.mode
  const globalSrcMode = this._compilation.__mpx__.srcMode
  const queryObj = loaderUtils.parseQuery(this.resourceQuery || '?')
  const localSrcMode = queryObj.mode
  const pagesMap = this._compilation.__mpx__.pagesMap
  const componentsMap = this._compilation.__mpx__.componentsMap
  const resource = stripExtension(this.resource)
  const isApp = !pagesMap[resource] && !componentsMap[resource]
  const srcMode = localSrcMode || globalSrcMode
  const fs = this._compiler.inputFileSystem
  const typeExtMap = Object.assign({}, config[srcMode].typeExtMap)

  function compileMPXJSON(source) {
    // eslint-disable-next-line no-new-func
    const func = new Function('exports', 'require', 'module', '__mpx_mode__', source)
    // 模拟commonJS执行
    // support exports
    const e = {}
    const m = {
      exports: e
    }
    func(e, require, m, mode)
    return JSON.stringify(m.exports, null, 2)
  }

  function tryEvalMPXJSON(callback) {
    fs.readFile(resource + EXT_MPX_JSON, (err, raw) => {
      if (err) {
        callback(err)
      } else {
        try {
          const source = raw.toString('utf-8')
          const text = compileMPXJSON(source)
          callback(null, { content: text, useMPXJSON: true })
        } catch (e) {
          callback(e)
        }
      }
    })
  }

  // 先读取json获取usingComponents信息
  async.waterfall([
    (callback) => {
      async.forEachOf(typeExtMap, (ext, key, callback) => {
        fs.stat(resource + ext, (err) => {
          if (err) {
            if (ext === typeExtMap['json']) {
              // .mpxjson.js也没有才删除
              fs.stat(resource + EXT_MPX_JSON, (err) => {
                if (err) {
                  delete typeExtMap[key]
                }
                callback()
              });
            } else {
              delete typeExtMap[key]
              callback()
            }
          } else {
            callback()
          }
        })
      }, callback)
    },
    (callback) => {
      // 对原生写法增强json写法，可以用js来写json，尝试找.mpxjson.js文件，找不到用回json的内容
      fs.stat(resource + EXT_MPX_JSON, (err) => {
        if (err) {
          fs.readFile(resource + typeExtMap['json'], (err, raw) => {
            callback(err, { content: raw.toString('utf-8') })
          })
        } else {
          tryEvalMPXJSON(callback)
        }
      });
    }, ({ content, useMPXJSON }, callback) => {
      let usingComponents = [].concat(this._compilation.__mpx__.usingComponents)
      try {
        let ret = JSON.parse(content)
        if (ret.usingComponents) {
          usingComponents = usingComponents.concat(Object.keys(ret.usingComponents))
        }
      } catch (e) {
      }
      const {
        getRequireForSrc,
        getNamedExportsForSrc
      } = createHelpers(
        loaderContext,
        options,
        moduleId,
        isProduction,
        hasScoped,
        hasComment,
        usingComponents,
        needCssSourceMap,
        srcMode,
        isNative,
        projectRoot
      )

      const getRequire = (type) => {
        let localQuery = Object.assign({}, queryObj)
        let src = resource + typeExtMap[type]
        localQuery.__resource = resource
        if (type !== 'script') {
          this.addDependency(src)
        }
        if (type === 'template' && isApp) {
          return ''
        }
        if (type === 'json') {
          localQuery.__component = true
        }
        src += stringifyQuery(localQuery)

        if (type === 'script') {
          return getNamedExportsForSrc(type, { src })
        } else {
          return getRequireForSrc(type, { src })
        }
      }

      // 注入模块id及资源路径
      let globalInjectCode = `global.currentModuleId = ${JSON.stringify(moduleId)};\n`
      globalInjectCode += `global.currentResource = ${JSON.stringify(filePath)};\n`

      // 注入构造函数
      let ctor = 'App'
      if (pagesMap[resource]) {
        ctor = mode === 'ali' ? 'Page' : 'Component'
      } else if (componentsMap[resource]) {
        ctor = 'Component'
      }
      globalInjectCode += `global.currentCtor = ${ctor};\n`

      if (isApp && mode === 'swan') {
        // 注入swan runtime fix
        globalInjectCode += 'if (!global.navigator) {\n' +
          '  global.navigator = {};\n' +
          '}\n' +
          'global.navigator.standalone = true;\n'
      }

      if (srcMode) {
        globalInjectCode += `global.currentSrcMode = ${JSON.stringify(srcMode)};\n`
      }

      const dep = new InjectDependency({
        content: globalInjectCode,
        index: -3
      })
      this._module.addDependency(dep)

      // 触发webpack global var 注入
      let output = 'global.currentModuleId;\n'

      let _promise

      for (let type in typeExtMap) {
        if (type === 'json') {
          if (useMPXJSON) {
            _promise = new Promise((resolve, reject) => {
              let _src = resource + EXT_MPX_JSON
              const resourcePath = pagesMap[resource] || componentsMap[resource]

              const childFilename = 'mpx-json-filename'
              const outputOptions = {
                filename: childFilename
              }
              const childCompiler = mainCompilation.createChildCompiler(_src, outputOptions, [
                new NodeTemplatePlugin(outputOptions),
                new NodeTargetPlugin(),
                new LibraryTemplatePlugin(null, 'commonjs2'),
                new SingleEntryPlugin(this.context, _src, resourcePath),
              ])

              let compiledMPXJSON
              childCompiler.hooks.afterCompile.tapAsync('MpxWebpackPlugin', (compilation, callback) => {
                const source = compilation.assets[childFilename] && compilation.assets[childFilename].source()

                // Remove all chunk assets
                compilation.chunks.forEach((chunk) => {
                  chunk.files.forEach((file) => {
                    delete compilation.assets[file]
                  })
                })

                compiledMPXJSON = compileMPXJSON(source)

                // 用了MPXJSON的话，强制生成目标json
                const s = new ConcatSource()
                s.add(compiledMPXJSON)
                compilation.assets[resourcePath + config[mode].typeExtMap['json']] = s

                callback()
              })

              childCompiler.runAsChild((err, entries, childCompilation) => {
                if (err) {
                  reject(err)
                } else {
                  childCompilation.fileDependencies.forEach((dep) => {
                    this.addDependency(dep)
                  }, this)
                  childCompilation.contextDependencies.forEach((dep) => {
                    this.addContextDependency(dep)
                  }, this)
                  resolve()
                }
              });
            })
            // 否则走原来的流程
          } else {
            output += `/* ${type} */\n${getRequire(type)}\n\n`
          }
        } else {
          output += `/* ${type} */\n${getRequire(type)}\n\n`
        }
      }

      if (_promise) {
        _promise
          .then(() => {
            callback(null, output)
          }, callback)
      } else {
        callback(null, output)
      }
    }
  ], nativeCallback)
}
