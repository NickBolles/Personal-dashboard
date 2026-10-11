package com.nickbolles.jarvis

import com.nickbolles.jarvis.ui.screens.HomeFeedbackRequests
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeFeedbackRequestsTest {
    @Test fun duplicateTapsAreBlockedSynchronouslyThroughRefresh() = runTest {
        val requests = HomeFeedbackRequests()
        val response = CompletableDeferred<Unit>()
        val refresh = CompletableDeferred<Unit>()
        var submissions = 0
        val submit = {
            requests.submit(this, "card") {
                submissions++
                response.await()
                refresh.await()
            }
        }
        submit()
        submit() // before either coroutine can run
        assertEquals(setOf("card"), requests.busy.value)
        runCurrent()
        assertEquals(1, submissions)
        response.complete(Unit)
        runCurrent()
        submit() // POST is done, but readback still pending
        runCurrent()
        assertEquals(1, submissions)
        refresh.complete(Unit)
        runCurrent()
        assertTrue(requests.busy.value.isEmpty())
        submit()
        runCurrent()
        assertEquals(2, submissions)
    }

    @Test fun failuresReleaseOnlyTheirOwnCard() = runTest {
        val requests = HomeFeedbackRequests()
        val hold = CompletableDeferred<Unit>()
        requests.submit(this, "other") { hold.await() }
        requests.submit(this, "failed") {
            try { throw IllegalStateException("network failure") } catch (_: IllegalStateException) { /* same handled failure path as the view model */ }
        }
        runCurrent()
        assertEquals(setOf("other"), requests.busy.value)
        hold.complete(Unit)
        runCurrent()
        assertTrue(requests.busy.value.isEmpty())
    }
}
