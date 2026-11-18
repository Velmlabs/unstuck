package sh.unstuck.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun WelcomeScreen(error: String?, onScan: () -> Unit, onCode: (String) -> Unit) {
    var code by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Unstuck", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text("Get an alert on this phone when your agent needs you, and take over its browser right here.")
        Spacer(Modifier.height(24.dp))
        Text("In your dashboard, open Phones and tap Add a phone. Then:")
        Spacer(Modifier.height(12.dp))
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("Scan QR code") }
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(value = code, onValueChange = { code = it }, label = { Text("Or enter the code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { onCode(code) }, enabled = code.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Pair") }
        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
fun SetupScreen(checklist: Checklist, notice: String?, onNotifications: () -> Unit, onBattery: () -> Unit, onTest: () -> Unit, onDone: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Almost there", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))
        Step("1. Allow notifications", checklist.notificationsAllowed, "Allow", onNotifications)
        Step("2. Battery: Unrestricted, so alerts arrive with the screen off", checklist.batteryUnrestricted, "Open setting", onBattery)
        Step("3. Send a test alert to this phone", false, "Send test", onTest)
        notice?.let { Text(it, Modifier.padding(vertical = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text("Done") }
    }
}

@Composable
private fun Step(label: String, done: Boolean, action: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text((if (done) "✓ " else "") + label, Modifier.weight(1f))
        if (!done) OutlinedButton(onClick = onClick) { Text(action) }
    }
}

@Composable
fun HomeScreen(label: String, notice: String?, onTest: () -> Unit, onUnpair: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Alerts on", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text("Paired as $label. When your agent needs you, an alert opens the takeover here.")
        Spacer(Modifier.height(24.dp))
        Button(onClick = onTest, modifier = Modifier.fillMaxWidth()) { Text("Send a test alert") }
        notice?.let { Text(it, Modifier.padding(vertical = 8.dp)) }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onUnpair, modifier = Modifier.fillMaxWidth()) { Text("Unpair this phone") }
    }
}
