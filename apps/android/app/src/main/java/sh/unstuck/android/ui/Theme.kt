package sh.unstuck.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The Unstuck brand (web/shared/tokens.css): dark slate, slate cards, green accent. */
object Brand {
    val Background = Color(0xFF0F172A)
    val Card = Color(0xFF1B2336)
    val CardRaised = Color(0xFF272F42)
    val Border = Color(0xFF334155)
    val Text = Color(0xFFF8FAFC)
    val Muted = Color(0xFF94A3B8)
    val Green = Color(0xFF22C55E)
    val GreenDim = Color(0xFF14532D)
    val OnGreen = Color(0xFF0F172A)
    val Danger = Color(0xFFF87171)
}

private val colors = darkColorScheme(
    primary = Brand.Green,
    onPrimary = Brand.OnGreen,
    primaryContainer = Brand.GreenDim,
    onPrimaryContainer = Brand.Text,
    secondary = Brand.Muted,
    onSecondary = Brand.Background,
    background = Brand.Background,
    onBackground = Brand.Text,
    surface = Brand.Background,
    onSurface = Brand.Text,
    surfaceVariant = Brand.Card,
    onSurfaceVariant = Brand.Muted,
    surfaceContainer = Brand.Card,
    surfaceContainerHigh = Brand.CardRaised,
    surfaceContainerHighest = Brand.CardRaised,
    outline = Brand.Border,
    outlineVariant = Brand.Border,
    error = Brand.Danger,
    onError = Brand.Background,
)

private val type = Typography(
    headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    labelLarge = TextStyle(fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp),
)

private val shapes = Shapes(
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
)

@Composable
fun UnstuckTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = colors, typography = type, shapes = shapes, content = content)
