#!/bin/zsh
# Перезапуск hh-agent перед окном запуска планировщика (09:55 / 15:25), чтобы к 10:00/15:30
# был свежий сервер и браузер. За сутки аптайма Playwright-контекст залипает («context closed»),
# а осиротевший chrome держит lock профиля и мешает чистому релончу — поэтому добиваем его и
# снимаем локи ПЕРЕД kickstart.
echo "[$(date '+%F %T')] restart-agent: добиваю осиротевший chrome + снимаю локи + kickstart"
pkill -9 -f 'hh-agent/profile' 2>/dev/null
rm -f "$HOME/.hh-agent/profile/Singleton"* 2>/dev/null
launchctl kickstart -k "gui/$(id -u)/com.aleksandr.hh-agent"
echo "[$(date '+%F %T')] restart-agent: kickstart отправлен"
