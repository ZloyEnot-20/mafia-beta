export type Language = "uz" | "ru";

const uz = {
  // Errors
  errorCreateRoom: "Xona yaratishda xato",
  errorJoinRoom: "Xonaga kirishda xato",
  errorRoomRequired: "Siz xonada emassiz",
  errorHostOnly: "Faqat host oʻyinni boshlashi mumkin",
  errorInvalidPhase: "Notoʻgʻri oʻyin bosqichi",
  errorDeadCannotAct: "Oʻlik oʻyinchilar harakat qila olmaydi",
  errorDeadCannotVote: "Oʻlik oʻyinchilar ovoz bera olmaydi",
  errorNotYourTurn: "Sizning navbatingiz emas",
  errorVoting: "Ovoz berishda xato",
  errorDeadCannotChat: "Oʻlik oʻyinchilar chatda yozolmaydi",
  roomCodeAndNameRequired: "Xona kodi va ism talab qilinadi",
  roomNotFound: "Xona topilmadi",

  // System messages
  playerReconnected: (name: string) => `${name} oʻyinga qayta ulandi`,
  playerDisconnected: (name: string) => `${name} oʻyindan uzildi`,
  nightFalls: "Kecha boshlanadi. Shahar uxlayapti...",
  nightMafiaWakes: "Kecha boshlanadi. Mafiya uygʻonmoqda...",
  morningFalls: "Ertalab keldi. Shahar uygʻonmoqda...",
  votedAgainstFull: (voter: string, voterIdx: number, target: string, targetIdx: number) =>
    `${voter} (${voterIdx}) ${target} (${targetIdx}) ga qarshi ovoz berdi`,
  system: "Tizim",
};

const ru = {
  // Errors
  errorCreateRoom: "Ошибка создания комнаты",
  errorJoinRoom: "Ошибка входа в комнату",
  errorRoomRequired: "Вы не в комнате",
  errorHostOnly: "Только хост может начать игру",
  errorInvalidPhase: "Неверная фаза игры",
  errorDeadCannotAct: "Мертвые игроки не могут действовать",
  errorDeadCannotVote: "Мертвые игроки не могут голосовать",
  errorNotYourTurn: "Не ваша очередь голосовать",
  errorVoting: "Ошибка при голосовании",
  errorDeadCannotChat: "Мертвые игроки не могут писать в чат",
  roomCodeAndNameRequired: "Код комнаты и имя игрока обязательны",
  roomNotFound: "Комната не найдена",

  // System messages
  playerReconnected: (name: string) => `${name} переподключился к игре`,
  playerDisconnected: (name: string) => `${name} отключился от игры`,
  nightFalls: "Наступает ночь. Город засыпает...",
  nightMafiaWakes: "Наступила ночь. Мафия просыпается...",
  morningFalls: "Наступило утро. Город просыпается...",
  votedAgainstFull: (voter: string, voterIdx: number, target: string, targetIdx: number) =>
    `${voter} (${voterIdx}) проголосовал против ${target} (${targetIdx})`,
  system: "Система",
};

const translations = { uz, ru } as const;

export function t(lang: Language, key: keyof typeof uz, ...args: unknown[]): string {
  const value = (translations[lang] ?? translations.uz)[key as keyof typeof uz];
  if (typeof value === "function") {
    return (value as (...a: unknown[]) => string)(...args);
  }
  return (value ?? String(key)) as string;
}
