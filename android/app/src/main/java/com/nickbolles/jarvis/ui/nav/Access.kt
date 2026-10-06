package com.nickbolles.jarvis.ui.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import com.nickbolles.jarvis.data.AuthMe

/**
 * What the signed-in person can use (GET /api/auth/me). Null while unknown:
 * then everything shows and the server's 403s still protect it. The server
 * enforces the same capabilities on every call; this only hides what they
 * can't use.
 */
val LocalAccess = staticCompositionLocalOf<AuthMe?> { null }

@Composable
fun can(capability: String): Boolean = LocalAccess.current?.can(capability) ?: true

@Composable
fun canAny(vararg capabilities: String): Boolean = capabilities.any { can(it) }
