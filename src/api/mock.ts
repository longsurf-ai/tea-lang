// @ts-nocheck -- executable API sketch; concrete WebSocket adapters are staged.

import { tea, fromWS, fromCSV, to} from 'tea'


var program = tea`
import strategy

var fast_window = input.int(14)
var slow_window = input.int(28)
var signal_window = input.int(9)

var fast_ema = ta.ema(close, fast_window)
var slow_ema = ta.ema(close, slow_window)
var signal_ema = ta.ema(close, signal_window)

var crossover = ta.crossover(fast_ema, slow_ema)
var divergence = ta.divergence(fast_ema, slow_ema)

if (crossover) {
    strategy.buy(1)
}
if (divergence) {
    strategy.sell(1)
}
`

const basket_combine = tea`
....
`

var s1 = fromCSV('wss://stream.longsurf.com/symbol/AAPL')
program = program.bind(s1).bind({fast_window: 14, slow_window: 28, signal_window: 9})
// program.ready() is true now
var sink = new WSSink('wss://localhost:8080/ws')

program.to(sink)
