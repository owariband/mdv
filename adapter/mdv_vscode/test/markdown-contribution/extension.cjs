exports.activate = () => ({
  extendMarkdownIt(md) {
    const original = md.renderer.rules.strong_open
    md.renderer.rules.strong_open = (tokens, index, options, env, renderer) => {
      tokens[index].attrSet('data-mdv-contribution-test', 'passed')
      return original ? original(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
    }
    return md
  },
})
