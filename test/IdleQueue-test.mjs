/*
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { IdleQueue } from '../dist/idleQueue.mjs'
import { rIC } from '../dist/idleCbWithPolyfill.mjs'
import { dispatchEvent, nextIdleCallback, when } from './helpers.mjs'

const isSafari_ = !!(typeof safari === 'object' && safari.pushNotification)

const sandbox = sinon.createSandbox()

function blockingSpy(ms) {
  return sandbox.stub().callsFake(() => {
    const startTime = +new Date()
    while (new Date() - startTime < ms) {
      // Do nothing.
    }
  })
}

async function getIdleDeadlinePrototype() {
  return await new Promise((resolve) => {
    rIC(deadline => resolve(deadline.constructor.prototype))
  })
}

/**
 * A wrapper around `sinon.stub()` that supports non-existent own properties.
 * @param {!object} obj
 * @param {string} prop
 * @param {*} value
 * @return {{value: !Function}}
 */
function stubProperty(obj, prop, value) {
  if (!obj.hasOwnProperty(prop)) {
    return {
      value: (value) => {
        Object.defineProperty(obj, prop, { value, configurable: true })
      },
    }
  }
  else {
    return sandbox.stub(obj, prop)
  }
}

describe(`IdleQueue`, () => {
  beforeEach(() => {
    sandbox.restore()
    stubProperty(document, 'visibilityState').value('visible')
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe(`constructor`, () => {
    it(`accepts a defaultMinTaskTime option`, async () => {
      const idleDeadlinePrototype = await getIdleDeadlinePrototype()

      let timeRemaining
      sandbox.stub(idleDeadlinePrototype, 'timeRemaining').callsFake(() => {
        return timeRemaining
      })

      const queue1 = new IdleQueue({ defaultMinTaskTime: 10 })
      const spy1 = sandbox.spy()
      const rICSpy1 = sandbox.spy()

      timeRemaining = 9
      queue1.pushTask(spy1)
      rIC(rICSpy1)

      // The added spy should not run because the timeRemaining value will
      // always be less than the defaultMinTaskTime.
      await when(() => rICSpy1.calledOnce)
      assert(spy1.notCalled)

      // Simulate a longer idle period and assert spy1 is eventually called.
      timeRemaining = 50
      await when(() => spy1.calledOnce)

      const queue2 = new IdleQueue({ defaultMinTaskTime: 25 })
      const spy2 = sandbox.spy()
      const rICSpy2 = sandbox.spy()

      timeRemaining = 26

      queue2.pushTask(spy2)
      rIC(rICSpy2)

      await when(() => rICSpy2.calledOnce)
      assert(spy1.calledOnce)

      queue1.destroy()
      queue2.destroy()
    })

    it(`adds lifecycle event listeners when ensureTasksRun is true`, () => {
      sandbox.spy(window, 'addEventListener')

      const queue = new IdleQueue({ ensureTasksRun: true })

      assert(window.addEventListener.calledWith(
        'visibilitychange',
        sinon.match.func,
        true,
      ))

      if (isSafari_) {
        assert(window.addEventListener.calledWith(
          'beforeunload',
          sinon.match.func,
          true,
        ))
      }
      else {
        assert(!window.addEventListener.calledWith(
          'beforeunload',
          sinon.match.func,
          true,
        ))
      }

      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      dispatchEvent(window, 'beforeunload')

      if (isSafari_) {
        assert(spy1.calledOnce)
        assert(spy2.calledOnce)
      }
      else {
        assert(spy1.notCalled)
        assert(spy2.notCalled)
      }

      const spy3 = sandbox.spy()
      const spy4 = sandbox.spy()
      const spy5 = sandbox.spy()

      queue.pushTask(spy3)
      queue.pushTask(spy4)
      queue.pushTask(spy5)

      stubProperty(document, 'visibilityState').value('hidden')
      dispatchEvent(document, 'visibilitychange')

      assert(spy3.calledOnce)
      assert(spy4.calledOnce)
      assert(spy5.calledOnce)

      queue.destroy()
    })

    it(`handles changes in lifecycle state while the queue is pending`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue({ ensureTasksRun: true })

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)

      assert(spy1.notCalled)
      assert(spy2.notCalled)
      assert(spy3.notCalled)

      dispatchEvent(window, 'beforeunload')

      if (isSafari_) {
        assert(spy1.calledOnce)
        assert(spy2.calledOnce)
        assert(spy3.calledOnce)
      }
      else {
        assert(spy1.notCalled)
        assert(spy2.notCalled)
        assert(spy3.notCalled)
      }

      stubProperty(document, 'visibilityState').value('hidden')
      dispatchEvent(document, 'visibilitychange')

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)
      assert(spy3.calledOnce)

      queue.destroy()
    })
  })

  describe(`pushTask`, () => {
    it(`queues a task to run when idle`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue()

      // Since this idle callback is scheduled before the spies are added,
      // It should always run first.
      rIC(() => {
        assert(spy1.notCalled)
        assert(spy2.notCalled)
        assert(spy3.notCalled)
      })

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)

      assert(spy1.notCalled)
      assert(spy2.notCalled)
      assert(spy3.notCalled)

      await when(() => spy3.calledOnce)

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)
      assert(spy3.calledOnce)

      queue.destroy()
    })

    it(`calls the task with the state at add time`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()

      const queue = new IdleQueue()

      const clock = sinon.useFakeTimers({ now: 1e12, toFake: ['Date'] })

      stubProperty(document, 'visibilityState').value('hidden')
      queue.pushTask(spy1)

      clock.tick(1000)

      stubProperty(document, 'visibilityState').value('visible')
      queue.pushTask(spy2)

      clock.restore()

      assert(spy1.notCalled)
      assert(spy2.notCalled)

      await when(() => spy2.calledOnce)

      assert(spy1.calledOnce)
      assert.strictEqual(spy1.firstCall.args[0].time, 1e12)
      assert.strictEqual(spy1.firstCall.args[0].visibilityState, 'hidden')

      assert(spy2.calledOnce)
      assert.strictEqual(spy2.firstCall.args[0].time, 1e12 + 1000)
      assert.strictEqual(spy2.firstCall.args[0].visibilityState, 'visible')

      queue.destroy()
    })

    it(`waits until the next idle period if all tasks cannot finish`, async () => {
      const spy1 = blockingSpy(5)
      const spy2 = blockingSpy(45)
      const spy3 = blockingSpy(5)
      const spy4 = blockingSpy(5)
      const rICSpy = sandbox.spy()

      const queue = new IdleQueue()

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)
      queue.pushTask(spy4)

      // This callback is queued after the 4 spies, but it should run at some
      // point before the last one (implying the queue needed to reschedule).
      rIC(rICSpy)

      assert(spy1.notCalled)
      assert(spy2.notCalled)
      assert(spy3.notCalled)
      assert(spy4.notCalled)
      assert(rICSpy.notCalled)

      await when(() => spy4.calledOnce)

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)
      assert(spy3.calledOnce)
      assert(spy4.calledOnce)

      assert(rICSpy.calledOnce)
      assert(rICSpy.calledBefore(spy4))

      queue.destroy()
    })

    it(`runs the task as a microtask when in the hidden state if ensureTasksRun is true`, async () => {
      stubProperty(document, 'visibilityState').value('hidden')

      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue({ ensureTasksRun: true })

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)

      assert(spy1.notCalled)
      assert(spy2.notCalled)
      assert(spy3.notCalled)

      // next microtask
      await Promise.resolve()

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)
      assert(spy3.calledOnce)

      queue.destroy()
    })

    it(`runs tasks in order`, async () => {
      const testQueueOrder = async (visibilityState) => {
        stubProperty(document, 'visibilityState').value(visibilityState)

        const spy1 = sandbox.spy()
        const spy2 = sandbox.spy()
        const spy3 = sandbox.spy()
        const queue = new IdleQueue()

        queue.pushTask(spy1)
        queue.pushTask(spy2)
        queue.pushTask(spy3)

        assert(spy1.notCalled)
        assert(spy2.notCalled)
        assert(spy3.notCalled)

        await when(() => spy3.calledOnce)

        assert(spy1.calledOnce)
        assert(spy1.calledBefore(spy2))
        assert(spy2.calledOnce)
        assert(spy2.calledBefore(spy3))
        assert(spy3.calledOnce)

        queue.destroy()
      }

      await testQueueOrder('visible')
      await testQueueOrder('hidden')
    })

    it(`runs nested tasks in order`, async () => {
      const testQueueOrder = async (visibilityState) => {
        stubProperty(document, 'visibilityState').value(visibilityState)

        const spy1 = sandbox.spy()
        const spy2 = sandbox.spy()
        const spy3 = sandbox.spy()
        const spy4 = sandbox.spy()
        const spy5 = sandbox.spy()
        const spy6 = sandbox.spy()

        const queue = new IdleQueue()

        queue.pushTask(spy1)
        queue.pushTask(() => {
          queue.pushTask(() => {
            spy4()
            queue.pushTask(spy6)
          })
          spy2()
        })
        queue.pushTask(() => {
          queue.pushTask(spy5)
          spy3()
        })

        await when(() => spy6.calledOnce)

        assert(spy1.calledOnce)
        assert(spy1.calledBefore(spy2))
        assert(spy2.calledOnce)
        assert(spy2.calledBefore(spy3))
        assert(spy3.calledOnce)
        assert(spy3.calledBefore(spy4))
        assert(spy4.calledOnce)
        assert(spy4.calledBefore(spy5))
        assert(spy5.calledOnce)
        assert(spy5.calledBefore(spy6))
        assert(spy6.calledOnce)

        queue.destroy()
      }

      await testQueueOrder('visible')
      await testQueueOrder('hidden')
    })

    it(`runs nested tasks in order across idle periods`, async () => {
      const spy1 = blockingSpy(5)
      const spy2 = blockingSpy(45)
      const spy3 = blockingSpy(5)
      const spy4 = blockingSpy(45)
      const spy5 = blockingSpy(5)
      const spy6 = blockingSpy(45)

      const queue = new IdleQueue()

      queue.pushTask(spy1)
      queue.pushTask(() => {
        queue.pushTask(() => {
          spy4()
          queue.pushTask(spy6)
        })
        spy2()
      })
      queue.pushTask(() => {
        queue.pushTask(spy5)
        spy3()
      })

      await when(() => spy6.calledOnce)

      assert(spy1.calledOnce)
      assert(spy1.calledBefore(spy2))
      assert(spy2.calledOnce)
      assert(spy2.calledBefore(spy3))
      assert(spy3.calledOnce)
      assert(spy3.calledBefore(spy4))
      assert(spy4.calledOnce)
      assert(spy4.calledBefore(spy5))
      assert(spy5.calledOnce)
      assert(spy5.calledBefore(spy6))
      assert(spy6.calledOnce)

      queue.destroy()
    })

    it(`accepts a minTaskTime option`, async () => {
      const idleDeadlinePrototype = await getIdleDeadlinePrototype()

      const queue = new IdleQueue()

      let timeRemaining
      sandbox.stub(idleDeadlinePrototype, 'timeRemaining').callsFake(() => {
        return timeRemaining
      })

      const spy1 = sandbox.spy()
      const rICSpy1 = sandbox.spy()

      timeRemaining = 13
      queue.pushTask(spy1)
      rIC(rICSpy1)

      // With the default minTaskTime, spy1 should be called before rICSpy1.
      await when(() => rICSpy1.calledOnce)
      assert(spy1.called)

      const spy2 = sandbox.spy()
      const rICSpy2 = sandbox.spy()

      queue.pushTask(spy2, { minTaskTime: 25 })
      rIC(rICSpy2)

      // With a minTaskTime of 25, rICSpy should be called before spy1.
      await when(() => rICSpy2.calledOnce)
      assert(spy2.notCalled)

      // Simulate a longer idle period.
      timeRemaining = 50

      await when(() => spy2.calledOnce)

      queue.destroy()
    })
  })

  describe(`unshiftTask`, () => {
    it(`adds a task to the beginning of the queue`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue()

      // Since this idle callback is scheduled before the spies are added,
      // It should always run first.
      rIC(() => {
        assert(spy1.notCalled)
        assert(spy2.notCalled)
        assert(spy3.notCalled)
      })

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.unshiftTask(spy3)

      assert(spy1.notCalled)
      assert(spy2.notCalled)
      assert(spy3.notCalled)

      await when(() => spy2.calledOnce)

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)
      assert(spy3.calledOnce)

      assert(spy3.calledBefore(spy1))
      assert(spy1.calledBefore(spy2))

      queue.destroy()
    })
  })

  describe(`clearPendingTasks`, () => {
    it(`removes scheduled tasks from the queue`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue()

      // Since this idle callback is scheduled before the spies are added,
      // It should always run first.
      rIC(() => {
        assert(spy1.notCalled)
        assert(spy2.notCalled)
        assert(spy3.notCalled)
      })

      queue.pushTask(spy1)
      queue.pushTask(spy2)

      assert(spy1.notCalled)
      assert(spy2.notCalled)

      queue.clearPendingTasks()
      queue.pushTask(spy3)

      await when(() => spy3.calledOnce)

      assert(spy3.calledOnce)

      // Assert spy1 and spy2 were actually cleared (and not run).
      assert(spy1.notCalled)
      assert(spy2.notCalled)

      queue.destroy()
    })
  })

  describe(`runTasksImmediately`, () => {
    it(`runs all pending tasks synchronously`, () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue()

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)

      assert(spy1.notCalled)
      assert(spy2.notCalled)
      assert(spy3.notCalled)

      queue.runTasksImmediately()

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)
      assert(spy3.calledOnce)

      queue.destroy()
    })

    it(`works when the queue is already running`, async () => {
      const spy1 = blockingSpy(5)
      const spy2 = blockingSpy(45)
      const spy3 = blockingSpy(5)
      const spy4 = blockingSpy(45)
      const spy5 = blockingSpy(5)
      const spy6 = blockingSpy(45)

      const queue = new IdleQueue()

      queue.pushTask(spy1)
      queue.pushTask(() => {
        queue.pushTask(() => {
          spy4()
          queue.pushTask(spy6)
        })
        spy2()
      })
      queue.pushTask(() => {
        queue.pushTask(spy5)
        spy3()
      })

      // This should run at some point in the middle of the 6 spies running.
      // Ensure that the remaining spies are called immediately.
      rIC(() => {
        assert(spy6.notCalled)

        queue.runTasksImmediately()

        assert(spy6.calledOnce)
      })

      await when(() => spy6.calledOnce)

      assert(spy1.calledOnce)
      assert(spy1.calledBefore(spy2))
      assert(spy2.calledOnce)
      assert(spy2.calledBefore(spy3))
      assert(spy3.calledOnce)
      assert(spy3.calledBefore(spy4))
      assert(spy4.calledOnce)
      assert(spy4.calledBefore(spy5))
      assert(spy5.calledOnce)
      assert(spy5.calledBefore(spy6))
      assert(spy6.calledOnce)

      queue.destroy()
    })

    it(`cancels pending idle callbacks to not run tasks twice`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const queue = new IdleQueue()

      queue.pushTask(spy1)
      queue.pushTask(spy2)

      assert(spy1.notCalled)
      assert(spy2.notCalled)

      queue.runTasksImmediately()

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)

      // Wait until the next idle point to assert the tasks weren't re-run.
      await nextIdleCallback()

      assert(spy1.calledOnce)
      assert(spy2.calledOnce)

      queue.destroy()
    })
  })

  describe(`hasPendingTasks`, () => {
    it(`returns true if there are tasks in the queue`, async () => {
      const spy1 = sandbox.spy()
      const spy2 = sandbox.spy()
      const spy3 = sandbox.spy()

      const queue = new IdleQueue()

      assert.strictEqual(queue.hasPendingTasks(), false)

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)

      assert.strictEqual(queue.hasPendingTasks(), true)

      await when(() => spy3.calledOnce)

      assert.strictEqual(queue.hasPendingTasks(), false)

      queue.destroy()
    })

    it(`returns true after running if more tasks are still scheduled`, async () => {
      const spy1 = blockingSpy(5)
      const spy2 = blockingSpy(45)
      const spy3 = blockingSpy(5)
      const spy4 = blockingSpy(5)

      const queue = new IdleQueue()

      assert.strictEqual(queue.hasPendingTasks(), false)

      queue.pushTask(spy1)
      queue.pushTask(spy2)
      queue.pushTask(spy3)
      queue.pushTask(spy4)

      assert.strictEqual(queue.hasPendingTasks(), true)

      // This callback is queued after the 4 spies, but it should run at some
      // point before the last one (implying the queue needed to reschedule).
      rIC(() => {
        assert.strictEqual(queue.hasPendingTasks(), true)
      })

      await when(() => spy4.calledOnce)

      assert.strictEqual(queue.hasPendingTasks(), false)

      queue.destroy()
    })
  })

  describe(`getState`, () => {
    it(`returns the state (at add time) of the currently running task`, async () => {
      const queue = new IdleQueue()

      const stub1 = sandbox.stub().callsFake((state) => {
        assert.strictEqual(queue.getState(), state)
        assert.strictEqual(queue.getState().time, 1e12)
        assert.strictEqual(queue.getState().visibilityState, 'hidden')
      })
      const stub2 = sandbox.stub().callsFake((state) => {
        assert.strictEqual(queue.getState(), state)
        assert.strictEqual(queue.getState().time, 1e12 + 1000)
        assert.strictEqual(queue.getState().visibilityState, 'visible')
      })

      const clock = sinon.useFakeTimers({ now: 1e12, toFake: ['Date'] })

      stubProperty(document, 'visibilityState').value('hidden')
      queue.pushTask(stub1)

      clock.tick(1000)

      stubProperty(document, 'visibilityState').value('visible')
      queue.pushTask(stub2)

      clock.restore()

      assert(stub1.notCalled)
      assert(stub2.notCalled)

      await when(() => stub2.calledOnce)

      assert(stub1.calledOnce)
      assert(stub2.calledOnce)

      queue.destroy()
    })

    it(`returns null if no tasks are running`, () => {
      const queue = new IdleQueue()

      assert.strictEqual(queue.getState(), null)

      queue.destroy()
    })
  })

  describe(`destroy`, () => {
    it(`removes added lifecycle listeners when ensureTasksRun is true`, () => {
      sandbox.spy(self, 'removeEventListener')

      const queue = new IdleQueue({ ensureTasksRun: true })
      assert(self.removeEventListener.notCalled)

      queue.destroy()

      assert(self.removeEventListener.calledWith(
        'visibilitychange',
        sinon.match.func,
        true,
      ))

      if (isSafari_) {
        assert(window.removeEventListener.calledWith(
          'beforeunload',
          sinon.match.func,
          true,
        ))
      }
      else {
        assert(!window.removeEventListener.calledWith(
          'beforeunload',
          sinon.match.func,
          true,
        ))
      }
    })
  })
})
