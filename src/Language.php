<?php
declare(strict_types=1);

namespace ForBirds;

/** Translates system errors only. API data and user content are never translated. */
final class Language
{
    private const EN = [
        'Используйте GET или POST.' => 'Use GET or POST.',
        'Получите CSRF-токен через GET /api/session.' => 'Get a CSRF token via GET /api/session.',
        'Аккаунт заблокирован.' => 'Your account is banned.',
        'Слишком большой запрос.' => 'The request is too large.',
        'JSON не должен превышать 128 КиБ.' => 'JSON must not exceed 128 KiB.',
        'Тело запроса должно быть JSON-объектом.' => 'The request body must be a JSON object.',
        'Некорректный JSON.' => 'Invalid JSON.',
        'Пустая форма или превышен post_max_size.' => 'Empty form or post_max_size exceeded.',
        'Отправьте JSON или HTML-форму.' => 'Send JSON or an HTML form.',
        'Имя: латинские буквы, цифры и _.' => 'Username: Latin letters, digits and underscores only.',
        'Имя уже занято.' => 'This username is already taken.',
        'Неверное имя или пароль.' => 'Incorrect username or password.',
        'Пароль должен содержать от 12 до 72 байт без нулевых символов.' => 'The password must contain 12 to 72 bytes without null characters.',
        'Выберите существующий флаг из списка.' => 'Choose an existing flag from the list.',
        'Используйте поле avatar для аватарки.' => 'Use the avatar field for your avatar.',
        'Не удалось загрузить аватарку. Выберите один файл.' => 'Could not upload your avatar. Choose one file.',
        'Нельзя одновременно загрузить и удалить аватарку.' => 'You cannot upload and remove an avatar at the same time.',
        'Аватарка должна быть не больше 2 МиБ.' => 'Your avatar must not exceed 2 MiB.',
        'Аватарка: JPEG, PNG, GIF или WebP.' => 'Avatar: JPEG, PNG, GIF or WebP.',
        'slug: строчные латинские буквы, цифры и дефисы.' => 'slug: lowercase Latin letters, digits and hyphens only.',
        'Такой раздел уже существует.' => 'This section already exists.',
        'Поисковая строка: 2–200 байт.' => 'Search query: 2–200 bytes.',
        'Размещение на главной и в новостях доступно персоналу.' => 'Only staff can feature posts on the home page or in updates.',
        'Тема закрыта.' => 'This topic is locked.',
        'Раздел находится в архиве.' => 'This section is archived.',
        'action: approve, unapprove, reject или delete.' => 'action: approve, unapprove, reject or delete.',
        'Удалённое сообщение нельзя восстановить через API.' => 'Deleted posts cannot be restored through the API.',
        'Нельзя изменять этого пользователя.' => 'You cannot modify this user.',
        'Через API можно назначить роль user или moderator.' => 'The API can assign the user or moderator role.',
        'Используйте поле files[].' => 'Use the files[] field.',
        'Можно приложить не более 10 файлов.' => 'You can attach up to 10 files.',
        'spoilers[] должен быть массивом индексов файлов.' => 'spoilers[] must be an array of file indices.',
        'Некорректный индекс спойлера.' => 'Invalid spoiler index.',
        'Некорректный загруженный файл.' => 'Invalid uploaded file.',
        'Лимит: 5 МиБ на файл, 20 МиБ на сообщение.' => 'Limit: 5 MiB per file, 20 MiB per post.',
        'Имя файла должно быть UTF-8.' => 'The filename must be UTF-8.',
        'Некорректное имя файла.' => 'Invalid filename.',
        'Недопустимое содержимое или расширение файла.' => 'Unsupported file content or extension.',
        'Некорректное или слишком большое изображение.' => 'Invalid image or image too large.',
        'Необходимо войти.' => 'You need to sign in.',
        'Требуются права модератора.' => 'Moderator permissions are required.',
        'Требуются права администратора.' => 'Administrator permissions are required.',
        'Ожидается положительное целое число до 999999999.' => 'A positive integer up to 999999999 is required.',
        'Слишком много запросов. Повторите позже.' => 'Too many requests. Please try again later.',
        'Не найдено.' => 'Not found.',
        'Решите локальную хэш-капчу перед публикацией.' => 'Compute the local hash proof before posting.',
        'Проверка истекла или уже использована. Получите новую задачу.' => 'The proof has expired or has already been used. Request a new challenge.',
        'Неверное решение хэш-капчи.' => 'Invalid hash proof.',
        'Для превью включите PHP GD с поддержкой JPEG, PNG, GIF и WebP.' => 'Enable PHP GD with JPEG, PNG, GIF and WebP support for previews.',
        'Изображение повреждено или превышает допустимые размеры.' => 'The image is damaged or exceeds the allowed dimensions.',
        'Для обработки изображения недостаточно памяти. Уменьшите его размеры.' => 'Not enough memory to process the image. Reduce its dimensions.',
        'Не удалось декодировать изображение.' => 'Could not decode the image.',
        'Сначала выполните php bin/console.php install.' => 'Run php bin/console.php install first.',
        'Внутренняя ошибка сервера.' => 'Internal server error.',
    ];

    public static function current(): string
    {
        // The UI sends its explicit selection, not the browser's inferred language.
        // Other API clients may use a standard weighted Accept-Language header.
        $best = 'ru';
        $quality = -1.0;
        foreach (explode(',', $_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '') as $part) {
            if (preg_match('/^\s*(ru|en)(?:-[a-z0-9-]+)?\s*(?:;\s*q=(0(?:\.\d+)?|1(?:\.0+)?))?\s*$/i', $part, $match)) {
                $q = isset($match[2]) ? (float) $match[2] : 1.0;
                if ($q > 0 && $q > $quality) {
                    $best = strtolower($match[1]);
                    $quality = $q;
                }
            }
        }
        return $best;
    }

    public static function error(string $message): string
    {
        if (self::current() !== 'en') {
            return $message;
        }
        if (isset(self::EN[$message])) {
            return self::EN[$message];
        }
        // Anchored patterns cover the API's parameterized system errors only.
        $patterns = [
            '/^До следующей публикации: (\d+) сек\.$/u' => 'You can post again in $1 seconds.',
            '/^Ошибка загрузки файла, код (\d+)\.$/u' => 'File upload failed, code $1.',
            '/^([a-z_]+) должен быть равен 1\.$/u' => '$1 must equal 1.',
            '/^Некорректное поле ([a-z_]+)\.$/u' => 'Invalid field: $1.',
            '/^Поле ([a-z_]+): от (\d+) до (\d+) байт UTF-8\.$/u' => 'Field $1: $2 to $3 UTF-8 bytes.',
            '/^Необходимо поле ([a-z_]+)\.$/u' => 'The $1 field is required.',
            '/^Поле ([a-z_]+) должно быть true\/false или 1\/0\.$/u' => 'Field $1 must be true/false or 1/0.',
        ];
        foreach ($patterns as $pattern => $replacement) {
            if (preg_match($pattern, $message)) {
                return preg_replace($pattern, $replacement, $message);
            }
        }
        return $message;
    }
}
