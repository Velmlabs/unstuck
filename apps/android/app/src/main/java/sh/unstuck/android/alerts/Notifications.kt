package sh.unstuck.android.alerts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat

object Notifications {
    const val CHANNEL = "takeovers"
    const val EXTRA_LINK = "sh.unstuck.android.LINK"
    private const val VIEWER = "sh.unstuck.android.viewer.ViewerActivity"

    /** "Takeovers": high importance, sound and vibration, so an alert gets through. */
    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Takeovers", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When your agent needs you"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400)
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
                )
            },
        )
    }

    fun show(context: Context, n: NotificationSpec) {
        ensureChannel(context)
        val tap = Intent().setComponent(ComponentName(context, VIEWER)).apply {
            n.openLink?.let { putExtra(EXTRA_LINK, it) }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pi = PendingIntent.getActivity(context, n.id, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, n.channel)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle(n.title)
            .setContentText(n.body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(n.id, notification)
    }
}
