// 校准集 v0：故意包含缺陷的极小项目（不要用于生产）。
const API_KEY = 'sk-live-KNOWN-BUGS-FIXTURE-NOT-REAL'

function currentValue() {
  return Number(document.getElementById('result').textContent.replace('当前值：', ''))
}

function update(value) {
  document.getElementById('result').textContent = `当前值：${value}`
}

document.getElementById('counter-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const delta = parseInt(document.getElementById('delta').value, 10)
  update(currentValue() + delta)
})
