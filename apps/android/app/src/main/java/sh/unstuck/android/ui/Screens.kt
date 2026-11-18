package sh.unstuck.android.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.unstuck.android.R

private val ButtonHeight = 52.dp

/** One scrolling column, clear of the system bars and the keyboard, at most phone-width on tablets. */
@Composable
private fun Page(content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxSize(), color = Brand.Background, contentColor = Brand.Text) {
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.widthIn(max = 480.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
                content = content,
            )
        }
    }
}

@Composable
private fun Brandmark(subtitle: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(R.drawable.logo_mark), contentDescription = null, modifier = Modifier.size(44.dp))
        Spacer(Modifier.width(12.dp))
        Column {
            Text("Unstuck", style = MaterialTheme.typography.titleLarge)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Brand.Muted) }
        }
    }
}

@Composable
private fun Heading(text: String) =
    Text(text, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })

@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = Brand.Card, contentColor = Brand.Text) {
        Column(Modifier.padding(20.dp), content = content)
    }
}

@Composable
private fun PrimaryButton(text: String, @DrawableRes icon: Int? = null, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = ButtonHeight), shape = MaterialTheme.shapes.medium) {
        icon?.let {
            Icon(painterResource(it), contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
        }
        Text(text)
    }
}

@Composable
private fun SecondaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonHeight),
        shape = MaterialTheme.shapes.medium,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Brand.Text),
    ) { Text(text) }
}

/** A short status line under an action (test result, error). */
@Composable
private fun Notice(text: String, error: Boolean = false) {
    Surface(Modifier.fillMaxWidth().padding(top = 12.dp), shape = MaterialTheme.shapes.medium, color = if (error) Brand.Danger.copy(alpha = 0.12f) else Brand.CardRaised) {
        Text(text, Modifier.padding(horizontal = 16.dp, vertical = 12.dp), style = MaterialTheme.typography.bodyMedium, color = if (error) Brand.Danger else Brand.Text)
    }
}

@Composable
fun WelcomeScreen(error: String?, onScan: () -> Unit, onCode: (String) -> Unit) {
    var code by remember { mutableStateOf("") }
    Page {
        Brandmark()
        Spacer(Modifier.height(40.dp))
        Heading("Get the alert when your agent is stuck")
        Spacer(Modifier.height(12.dp))
        Text(
            "A CAPTCHA, a sign-in, a question: this phone gets the alert, and you take over the agent's browser right here.",
            style = MaterialTheme.typography.bodyLarge,
            color = Brand.Muted,
        )
        Spacer(Modifier.height(28.dp))
        Card {
            Text("Pair this phone", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text("In your Unstuck dashboard, open Phones and choose Add a phone.", style = MaterialTheme.typography.bodyMedium, color = Brand.Muted)
            Spacer(Modifier.height(20.dp))
            PrimaryButton("Scan the QR code", icon = R.drawable.ic_qr, onClick = onScan)
            Row(Modifier.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(Modifier.weight(1f), color = Brand.Border)
                Text("or type the code", Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.labelMedium, color = Brand.Muted)
                HorizontalDivider(Modifier.weight(1f), color = Brand.Border)
            }
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.uppercase().take(16) },
                placeholder = { Text("ABCD-EFGH", fontFamily = FontFamily.Monospace, color = Brand.Muted.copy(alpha = 0.6f)) },
                label = { Text("Pairing code") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, fontSize = 20.sp, letterSpacing = 2.sp),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { if (code.isNotBlank()) onCode(code) }),
                shape = MaterialTheme.shapes.medium,
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Brand.Border, focusedBorderColor = Brand.Green, focusedLabelColor = Brand.Green, cursorColor = Brand.Green),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            SecondaryButton("Pair", enabled = code.isNotBlank()) { onCode(code) }
            error?.let { Notice(it, error = true) }
        }
    }
}

@Composable
fun SetupScreen(checklist: Checklist, notice: String?, onNotifications: () -> Unit, onBattery: () -> Unit, onTest: () -> Unit, onDone: () -> Unit) {
    val tested = notice?.startsWith("Test alert sent") == true
    Page {
        Brandmark()
        Spacer(Modifier.height(40.dp))
        Heading("Almost there")
        Spacer(Modifier.height(8.dp))
        Text("Three quick steps so alerts reach you, even with the screen off.", style = MaterialTheme.typography.bodyLarge, color = Brand.Muted)
        Spacer(Modifier.height(24.dp))
        Step(R.drawable.ic_bell, "Allow notifications", "So Unstuck can show the alert.", checklist.notificationsAllowed, "Allow", onNotifications)
        Spacer(Modifier.height(12.dp))
        Step(R.drawable.ic_battery, "Battery: Unrestricted", "Android otherwise holds alerts back while the phone sleeps.", checklist.batteryUnrestricted, "Open", onBattery)
        Spacer(Modifier.height(12.dp))
        Step(R.drawable.ic_send, "Send a test alert", "It should arrive within a few seconds.", tested, "Send", onTest)
        notice?.takeUnless { tested }?.let { Notice(it) }
        Spacer(Modifier.height(28.dp))
        PrimaryButton(if (checklist.notificationsAllowed && checklist.batteryUnrestricted) "Finish" else "Finish later", onClick = onDone)
    }
}

@Composable
private fun Step(@DrawableRes icon: Int, title: String, detail: String, done: Boolean, action: String, onClick: () -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = Brand.Card, contentColor = Brand.Text) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(40.dp).background(if (done) Brand.Green else Brand.CardRaised, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(if (done) R.drawable.ic_check else icon), contentDescription = null, tint = if (done) Brand.OnGreen else Brand.Text, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(if (done) "Done" else detail, style = MaterialTheme.typography.bodyMedium, color = if (done) Brand.Green else Brand.Muted)
            }
            if (!done) {
                Spacer(Modifier.width(12.dp))
                OutlinedButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp), shape = MaterialTheme.shapes.medium, colors = ButtonDefaults.outlinedButtonColors(contentColor = Brand.Green)) {
                    Text(action)
                }
            }
        }
    }
}

@Composable
fun HomeScreen(label: String, notice: String?, onTest: () -> Unit, onUnpair: () -> Unit) {
    Page {
        Brandmark()
        Spacer(Modifier.height(40.dp))
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(12.dp).background(Brand.Green, CircleShape).border(3.dp, Brand.Green.copy(alpha = 0.3f), CircleShape))
                Spacer(Modifier.width(10.dp))
                Text("ALERTS ON", style = MaterialTheme.typography.labelMedium, color = Brand.Green)
            }
            Spacer(Modifier.height(12.dp))
            Heading("You'll get the alert here")
            Spacer(Modifier.height(8.dp))
            Text("When your agent needs you, tap the alert to take over its browser in this app.", style = MaterialTheme.typography.bodyLarge, color = Brand.Muted)
            Spacer(Modifier.height(16.dp))
            HorizontalDivider(color = Brand.Border)
            Spacer(Modifier.height(12.dp))
            Text("Paired as", style = MaterialTheme.typography.labelMedium, color = Brand.Muted)
            Text(label, style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Send a test alert", icon = R.drawable.ic_send, onClick = onTest)
        notice?.let { Notice(it) }
        Spacer(Modifier.height(32.dp))
        Text(
            "Turn this phone's alerts on or off any time in the dashboard, under Phones.",
            style = MaterialTheme.typography.bodyMedium,
            color = Brand.Muted,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onUnpair, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), colors = ButtonDefaults.textButtonColors(contentColor = Brand.Danger)) {
            Text("Unpair this phone")
        }
    }
}
