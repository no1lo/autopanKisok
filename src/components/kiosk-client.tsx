"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowLeft,
  Check,
  Gamepad2,
  Monitor,
  Search,
  Users,
} from "lucide-react";

import {
  isElementaryGradeOneOrOlderBirthYear,
} from "@/lib/kiosk-policy";
import {
  getKioskBackTarget,
  isKioskIdentityReady,
  type KioskFlowStep,
} from "@/lib/kiosk-flow";
import { useLiveSnapshot } from "@/hooks/use-live-snapshot";
import { getJson, postMutation } from "@/lib/client-api";
import {
  RESOURCE_TYPE_LABELS,
  RESOURCE_TYPE_SHORT_LABELS,
  type ResourceType,
} from "@/lib/domain";
import { sortPricingRules, getResourceSummary } from "@/lib/selectors";
import type { SnapshotEnvelope } from "@/lib/snapshot";
import { formatMinutes } from "@/lib/utils";

type KioskResourceChoice = ResourceType;
type CompletionState = {
  kind: "paid" | "space";
  message: string;
};

type BlockingDialogState = {
  title: string;
  message: string;
};

type AudioCue =
  | "paidComplete"
  | "spaceComplete"
  | "gameLimitFull"
  | "gameLimitNotEnough"
  | "underageBlocked"
  | "selectUserRequired"
  | "invalidIntakeInfo"
  | "intakeFailed"
  | "searchNameOrPhone"
  | "noMyInfoRegister"
  | "sameNameCheck"
  | "newMemberIntro"
  | "privacyConsentRequired"
  | "requiredFieldsMissing"
  | "deskPaymentShort"
  | "queueWaitNotice"
  | "spaceCompleteSafe"
  | "systemError";

function getBlockingAudioCue(message: string): AudioCue {
  if (message.includes("2시간을 모두")) {
    return "gameLimitFull";
  }

  if (
    message.includes("오늘 이용 시간이 부족해요") ||
    message.includes("하루 2시간") ||
    message.includes("남은 시간")
  ) {
    return "gameLimitNotEnough";
  }

  if (message.includes("초등학교 1학년")) {
    return "underageBlocked";
  }

  if (message.includes("이용자를 선택")) {
    return "selectUserRequired";
  }

  if (message.includes("접수 정보")) {
    return "invalidIntakeInfo";
  }

  if (message.includes("빨간 표시")) {
    return "requiredFieldsMissing";
  }

  if (message.includes("잠시 문제가")) {
    return "systemError";
  }

  return "intakeFailed";
}

type MemberFormState = {
  name: string;
  schoolName: string;
  birthYear: string;
  birthMonth: string;
  birthDay: string;
  gender: "male" | "female" | "";
  guardianPhone: string;
};

type SheetMember = {
  id: string;
  name: string;
  schoolName?: string;
  birthDate?: string;
  gradeOrAge: string;
  gender?: "male" | "female";
  guardianPhone: string;
};

const DEFAULT_FORM: MemberFormState = {
  name: "",
  schoolName: "",
  birthYear: "",
  birthMonth: "",
  birthDay: "",
  gender: "",
  guardianPhone: "",
};

const CURRENT_YEAR = new Date().getFullYear();
const MIN_BIRTH_YEAR = CURRENT_YEAR - 25;
const COMPLETION_TTS_PLAYBACK_RATE = 1.5;
const BIRTH_YEAR_OPTIONS = Array.from(
  { length: CURRENT_YEAR - MIN_BIRTH_YEAR + 1 },
  (_, index) => String(CURRENT_YEAR - index),
);
const BIRTH_MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);
const POPULAR_SCHOOLS = ["중평초", "중원초", "상천초", "당현초"] as const;

function normalizePhoneInput(value: string) {
  return value.replace(/\D/g, "");
}
function getBirthDateValue(formState: MemberFormState) {
  if (!formState.birthYear || !formState.birthMonth || !formState.birthDay) {
    return "";
  }

  return `${formState.birthYear}-${formState.birthMonth}-${formState.birthDay}`;
}

function getBirthDayOptions(year: string, month: string) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  const dayCount =
    parsedYear > 0 && parsedMonth > 0
      ? new Date(parsedYear, parsedMonth, 0).getDate()
      : 31;

  return Array.from({ length: dayCount }, (_, index) =>
    String(index + 1).padStart(2, "0"),
  );
}

function formatMemberAgeLabel(value: string) {
  const birthYear = Number(value.slice(0, 4));

  if (/^\d{4}/.test(value) && birthYear > 0) {
    return `${CURRENT_YEAR - birthYear + 1}살`;
  }

  return value;
}

function getBirthYear(value: string) {
  return value.slice(0, 4);
}

function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.length >= 10) {
    return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
  }

  return value;
}

function getNewMemberNamePrefill(query: string) {
  const trimmed = query.trim();

  return /\d/.test(trimmed) ? "" : trimmed;
}

function getCompletionSpeechMessage(
  memberName: string,
  choice: KioskResourceChoice,
) {
  const contentLabel =
    choice === "space"
      ? "공간 이용"
      : choice === "playstation"
        ? "플스"
        : RESOURCE_TYPE_LABELS[choice];

  return `${memberName.trim()}님, ${contentLabel} 접수 완료되었습니다.`;
}

const RESOURCE_CARD_THEME: Record<
  Exclude<ResourceType, "space">,
  {
    background: string;
    text: string;
    pill: string;
  }
> = {
  pc: {
    background: "bg-[#dfe8ff]",
    text: "text-[#24367f]",
    pill: "bg-[#4562ff] text-white",
  },
  nintendo: {
    background: "bg-[#dff5ea]",
    text: "text-[#1f6a4b]",
    pill: "bg-[#2f9b68] text-white",
  },
  playstation: {
    background: "bg-[#f7dff3]",
    text: "text-[#7e2b78]",
    pill: "bg-[#c14ab4] text-white",
  },
};

function MemberButton({
  name,
  gradeOrAge,
  guardianPhone,
  isSelected,
  onSelect,
}: {
  name: string;
  gradeOrAge: string;
  guardianPhone: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={`grid min-h-[88px] w-full grid-cols-[minmax(0,1fr)_112px] items-center gap-4 rounded-[18px] border px-4 py-3 text-left transition sm:grid-cols-[minmax(0,1fr)_144px] sm:px-5 ${
        isSelected
          ? "border-2 border-[color:var(--accent)] bg-[color:var(--accent-soft)]"
          : "border-[color:var(--line)] bg-[color:var(--surface-strong)] hover:bg-[color:var(--surface)]"
      }`}
    >
      <div className="min-w-0">
        <div className="text-[18px] font-bold text-[color:var(--foreground)]">
          {name}
        </div>
        <div className="mt-1 text-[13px] leading-5 text-[color:var(--muted)]">
          {formatMemberAgeLabel(gradeOrAge)} · 보호자 연락처{" "}
          {maskPhone(guardianPhone)}
        </div>
      </div>
      <span
        aria-hidden="true"
        className={`inline-flex min-h-14 w-full items-center justify-center gap-1.5 rounded-[14px] px-3 text-[16px] font-black ${
          isSelected
            ? "bg-[color:var(--success)] text-white"
            : "bg-[color:var(--accent)] text-white"
        }`}
      >
        {isSelected ? <Check className="size-5" strokeWidth={3} /> : null}
        {isSelected ? "선택됨" : "선택하기"}
      </span>
    </button>
  );
}

function ResourceCard({
  label,
  shortLabel,
  icon: Icon,
  theme,
  selected,
  free,
  waiting,
  showCounts = true,
  onClick,
}: {
  label: string;
  shortLabel: string;
  icon: typeof Monitor;
  theme: {
    background: string;
    text: string;
    pill: string;
  };
  selected: boolean;
  free: number;
  waiting: number;
  showCounts?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-full min-h-[176px] rounded-[20px] border p-5 text-left transition ${
        selected
          ? "border-[color:var(--accent)] shadow-[var(--shadow-soft)]"
          : "border-[color:var(--line)]"
      } ${theme.background}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className={`text-xs uppercase tracking-[0.24em] ${theme.text}`}>
            {shortLabel}
          </div>
          <div
            className={`mt-2 text-3xl font-black tracking-tight ${theme.text}`}
          >
            {label}
          </div>
        </div>
        <div className="rounded-2xl bg-white/80 p-3 text-[color:var(--foreground)]">
          <Icon className="size-6" />
        </div>
      </div>
      {showCounts ? (
        <div className="mt-6 flex flex-wrap gap-2">
          <span
            className={`rounded-full px-3 py-1 text-sm font-semibold ${theme.pill}`}
          >
            빈 자리 {free}
          </span>
          <span className="rounded-full bg-white/80 px-3 py-1 text-sm font-semibold text-[color:var(--foreground)]">
            대기 {waiting}
          </span>
        </div>
      ) : null}
    </button>
  );
}

function TimeButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[18px] border px-5 py-4 text-left transition ${
        selected
          ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)]"
          : "border-[color:var(--line)] bg-[color:var(--surface-strong)] hover:bg-[color:var(--surface)]"
      }`}
    >
      <div className="text-[16px] font-semibold text-[color:var(--foreground)]">
        {label}
      </div>
    </button>
  );
}

export function KioskClient({ initial }: { initial: SnapshotEnvelope }) {
  const { snapshot, refresh } = useLiveSnapshot(initial, 5000);
  const [tab, setTab] = useState<"existing" | "new" | null>(null);
  const [step, setStep] = useState<KioskFlowStep>("entry");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [sheetMembers, setSheetMembers] = useState<SheetMember[]>([]);
  const [isMemberSearchLoading, setIsMemberSearchLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [hasSearchedMembers, setHasSearchedMembers] = useState(false);
  const [resourceChoice, setResourceChoice] =
    useState<KioskResourceChoice | null>(null);
  const [pricingRuleId, setPricingRuleId] = useState("");
  const [formState, setFormState] = useState<MemberFormState>(DEFAULT_FORM);
  const [attemptedNewMemberSubmit, setAttemptedNewMemberSubmit] =
    useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [blockingDialog, setBlockingDialog] =
    useState<BlockingDialogState | null>(null);
  const [notice, setNotice] = useState("");
  const [phoneHint, setPhoneHint] = useState("");
  const [isPending, startTransition] = useTransition();
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechVoicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const speechUnlockedRef = useRef(false);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const ttsBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const memberSearchRequestSeqRef = useRef(0);
  const submitInFlightRef = useRef(false);

  const visibleMembers = sheetMembers;
  const selectedMember = sheetMembers.find(
    (member) => member.id === selectedMemberId,
  );
  const showNewMemberRegistrationChoice =
    hasSearchedMembers && !isMemberSearchLoading;
  const selectedResourceType =
    resourceChoice && resourceChoice !== "space" ? resourceChoice : null;
  const pricingRules = selectedResourceType
    ? sortPricingRules(snapshot.pricingRules, selectedResourceType).filter(
        (rule) => !rule.isExtension,
      )
    : [];
  const effectivePricingRuleId =
    pricingRuleId && pricingRules.some((rule) => rule.id === pricingRuleId)
      ? pricingRuleId
      : "";
  const birthDateValue = getBirthDateValue(formState);
  const birthDayOptions = getBirthDayOptions(
    formState.birthYear,
    formState.birthMonth,
  );

  const identityReady = isKioskIdentityReady({
    identityMode: tab,
    hasSelectedMember: Boolean(selectedMember),
    hasCompleteNewMemberForm: Boolean(
      formState.name &&
        formState.schoolName &&
        birthDateValue &&
        formState.gender &&
        formState.guardianPhone,
    ),
  });
  const canSubmit = Boolean(
    privacyAgreed &&
    identityReady &&
    (resourceChoice === "space" ||
      (selectedResourceType && effectivePricingRuleId)),
  );
  const resourceSummaries = {
    pc: getResourceSummary(snapshot, "pc"),
    nintendo: getResourceSummary(snapshot, "nintendo"),
    playstation: getResourceSummary(snapshot, "playstation"),
  };
  const missingNewMemberFields = {
    name: !formState.name.trim(),
    schoolName: !formState.schoolName.trim(),
    birthDate: !birthDateValue,
    gender: !formState.gender,
    guardianPhone: !formState.guardianPhone.trim(),
  };
  const showNewMemberErrors = attemptedNewMemberSubmit && tab === "new";
  const hasNewMemberErrors = Object.values(missingNewMemberFields).some(
    Boolean,
  );
  const errorInputClass =
    "border-red-400 bg-red-50 text-red-950 placeholder:text-red-300 focus:border-red-500 focus:ring-2 focus:ring-red-100";
  const getInputClassName = (hasError: boolean, className = "text-[16px]") =>
    `toss-input ${className} ${showNewMemberErrors && hasError ? errorInputClass : ""}`;
  const errorText = (message: string) => (
    <p className="mt-1 text-sm font-semibold text-red-600">{message}</p>
  );

  const prepareSpeechSynthesis = useCallback(() => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    const synth = window.speechSynthesis;
    speechVoicesRef.current = synth.getVoices();
    synth.resume();

    if (speechUnlockedRef.current) {
      return;
    }

    speechUnlockedRef.current = true;
    const primer = new SpeechSynthesisUtterance(" ");
    primer.lang = "ko-KR";
    primer.volume = 0.01;
    primer.rate = 1;
    currentUtteranceRef.current = primer;
    synth.speak(primer);
  }, []);

  const prepareGeneratedTtsPlayback = useCallback(() => {
    const audioWindow = window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextCtor =
      audioWindow.AudioContext ?? audioWindow.webkitAudioContext;

    if (!AudioContextCtor) {
      return null;
    }

    const context =
      audioContextRef.current ?? new AudioContextCtor({ latencyHint: "interactive" });
    audioContextRef.current = context;

    if (context.state === "suspended") {
      void context.resume();
    }

    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    source.connect(context.destination);

    try {
      source.start(0);
    } catch {
      // Some browsers reject a second start on an already-consumed silent source.
    }

    return context;
  }, []);

  const resetFlow = useCallback(() => {
    memberSearchRequestSeqRef.current += 1;
    setStep("entry");
    setTab(null);
    setSelectedMemberId("");
    setSheetMembers([]);
    setIsMemberSearchLoading(false);
    setQuery("");
    setHasSearchedMembers(false);
    setResourceChoice(null);
    setPricingRuleId("");
    setFormState(DEFAULT_FORM);
    setAttemptedNewMemberSubmit(false);
    setPrivacyAgreed(false);
    setCompletion(null);
    setBlockingDialog(null);
    setNotice("");
    setPhoneHint("");
  }, []);

  const searchSheetMembers = async () => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      searchInputRef.current?.focus({ preventScroll: true });
      setNotice("이름 또는 연락처를 입력한 뒤 검색해 주세요.");
      speakKioskMessage(
        "이름이나 보호자 연락처를 입력하고 검색해 주세요.",
        "searchNameOrPhone",
      );
      setSheetMembers([]);
      setSelectedMemberId("");
      setHasSearchedMembers(false);
      return;
    }

    searchInputRef.current?.blur();
    setIsMemberSearchLoading(true);
    setNotice("");
    setSelectedMemberId("");
    const requestSeq = memberSearchRequestSeqRef.current + 1;
    memberSearchRequestSeqRef.current = requestSeq;

    try {
      const params = new URLSearchParams({ q: trimmedQuery });
      const data = await getJson<{ ok: true; members: SheetMember[] }>(
        `/api/sheet-members?${params.toString()}`,
      );

      if (memberSearchRequestSeqRef.current !== requestSeq) {
        return;
      }

      setSheetMembers(data.members);
      setHasSearchedMembers(true);
      if (data.members.length === 0) {
        speakKioskMessage(
          "내 정보가 없으면 새로 등록해 주세요.",
          "noMyInfoRegister",
        );
      } else {
        speakKioskMessage(
          "이름이 같아도 나이와 보호자 연락처가 다르면 내 정보가 아닐 수 있어요.",
          "sameNameCheck",
        );
      }
    } catch (error) {
      if (memberSearchRequestSeqRef.current !== requestSeq) {
        return;
      }

      setSheetMembers([]);
      setHasSearchedMembers(true);
      setNotice(
        error instanceof Error ? error.message : "이용자 검색에 실패했습니다.",
      );
    } finally {
      if (memberSearchRequestSeqRef.current === requestSeq) {
        setIsMemberSearchLoading(false);
        window.setTimeout(() => {
          searchResultsRef.current?.scrollIntoView({
            block: "nearest",
            behavior: "smooth",
          });
        }, 80);
      }
    }
  };

  const getSelectedSheetMemberPayload = () => {
    if (!selectedMember) {
      return null;
    }

    const birthYear =
      selectedMember.gradeOrAge || getBirthYear(selectedMember.birthDate ?? "");

    return {
      member: {
        name: selectedMember.name,
        gradeOrAge: birthYear,
        guardianPhone: selectedMember.guardianPhone,
      },
      sheetMetadata: {
        schoolName: selectedMember.schoolName,
        birthDate: selectedMember.birthDate,
        gender: selectedMember.gender,
      },
    };
  };

  const goBack = () => {
    if (isPending || submitInFlightRef.current) {
      return;
    }

    setNotice("");

    const target = getKioskBackTarget({
      step,
      identityMode: tab,
      hasSelectedResourceType: Boolean(selectedResourceType),
    });

    if (!target) {
      return;
    }

    if (step === "existing-member") {
      memberSearchRequestSeqRef.current += 1;
      setIsMemberSearchLoading(false);
    }

    if (step === "new-member") {
      setAttemptedNewMemberSubmit(false);
      setPrivacyAgreed(false);
      setPhoneHint("");
      setBlockingDialog(null);
    }

    setTab(target.identityMode);
    setStep(target.step);
  };

  useEffect(() => {
    const clearInactivityTimer = () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };
    const resetInactivityTimer = () => {
      clearInactivityTimer();

      if (isPending || submitInFlightRef.current || completion) {
        return;
      }

      inactivityTimerRef.current = setTimeout(() => {
        resetFlow();
      }, 30_000);
    };

    resetInactivityTimer();

    const eventTypes: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "input",
      "touchstart",
    ];

    eventTypes.forEach((eventName) => {
      window.addEventListener(eventName, resetInactivityTimer);
    });

    return () => {
      clearInactivityTimer();

      eventTypes.forEach((eventName) => {
        window.removeEventListener(eventName, resetInactivityTimer);
      });
    };
  }, [completion, isPending, resetFlow]);

  useEffect(
    () => () => {
      if (completionTimerRef.current) {
        clearTimeout(completionTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const loadVoices = () => {
      if (!("speechSynthesis" in window)) {
        return;
      }

      speechVoicesRef.current = window.speechSynthesis.getVoices();
    };

    const unlockPlayback = () => {
      prepareSpeechSynthesis();
      prepareGeneratedTtsPlayback();
    };

    loadVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", loadVoices);
    window.addEventListener("pointerdown", unlockPlayback, { passive: true });
    window.addEventListener("touchend", unlockPlayback, { passive: true });
    window.addEventListener("click", unlockPlayback, { passive: true });

    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", loadVoices);
      window.removeEventListener("pointerdown", unlockPlayback);
      window.removeEventListener("touchend", unlockPlayback);
      window.removeEventListener("click", unlockPlayback);
    };
  }, [prepareGeneratedTtsPlayback, prepareSpeechSynthesis]);

  const speakWithWebSpeech = useCallback((message: string) => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    const synth = window.speechSynthesis;
    const voices =
      speechVoicesRef.current.length > 0
        ? speechVoicesRef.current
        : synth.getVoices();
    const koreanVoice =
      voices.find((voice) => voice.lang.toLowerCase() === "ko-kr") ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith("ko"));
    const utterance = new SpeechSynthesisUtterance(message);

    utterance.lang = koreanVoice?.lang ?? "ko-KR";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.volume = 1;

    if (koreanVoice) {
      utterance.voice = koreanVoice;
    }

    utterance.onerror = (event) => {
      console.warn("Kiosk TTS failed.", { error: event.error });
    };

    currentUtteranceRef.current = utterance;
    synth.cancel();
    synth.resume();
    window.setTimeout(() => {
      synth.resume();
      synth.speak(utterance);
    }, 80);
  }, []);

  const playGeneratedTts = useCallback(
    async (message: string) => {
      const ttsUrl = `/api/tts?text=${encodeURIComponent(message)}`;

      try {
        const context = prepareGeneratedTtsPlayback();

        if (!context) {
          return false;
        }

        if (context.state === "suspended") {
          await context.resume();
        }

        let audioBuffer = ttsBufferCacheRef.current.get(message);

        if (!audioBuffer) {
          const response = await fetch(ttsUrl, { cache: "no-store" });

          if (!response.ok) {
            throw new Error(`TTS request failed: ${response.status}`);
          }

          audioBuffer = await context.decodeAudioData(
            await response.arrayBuffer(),
          );
          ttsBufferCacheRef.current.set(message, audioBuffer);
        }

        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = COMPLETION_TTS_PLAYBACK_RATE;
        source.connect(context.destination);
        source.start(0);

        return true;
      } catch (error) {
        console.warn("Generated kiosk TTS failed.", error);

        try {
          const audio = new Audio(ttsUrl);
          audio.preload = "auto";
          audio.playbackRate = COMPLETION_TTS_PLAYBACK_RATE;
          await audio.play();
          return true;
        } catch (audioError) {
          console.warn("Generated kiosk audio element TTS failed.", audioError);
          return false;
        }
      }
    },
    [prepareGeneratedTtsPlayback],
  );

  const announceCompletion = useCallback(
    async (message: string) => {
      const playedGeneratedTts = await playGeneratedTts(message);

      if (!playedGeneratedTts) {
        speakWithWebSpeech(message);
      }
    },
    [playGeneratedTts, speakWithWebSpeech],
  );

  const speakKioskMessage = useCallback(
    (message: string, audioCue?: AudioCue) => {
      void message;
      void audioCue;
      void speakWithWebSpeech;

      // Voice guidance is temporarily disabled.
      // speakWithWebSpeech(message);
    },
    [speakWithWebSpeech],
  );

  const showBlockingDialog = useCallback(
    (title: string, message: string, audioCue?: AudioCue) => {
      setNotice(message);
      setBlockingDialog({ title, message });
      speakKioskMessage(message, audioCue);
    },
    [speakKioskMessage],
  );

  const finishCompletion = useCallback(() => {
    if (completionTimerRef.current) {
      clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }

    resetFlow();
    refresh();
  }, [refresh, resetFlow]);

  const submitVisit = () => {
    if (submitInFlightRef.current) {
      return;
    }

    prepareSpeechSynthesis();
    prepareGeneratedTtsPlayback();

    if (!canSubmit || !resourceChoice) {
      showBlockingDialog(
        "접수 정보를 확인해 주세요",
        "접수 정보를 다시 확인해 주세요.",
        "invalidIntakeInfo",
      );
      return;
    }

    const identityPayload =
      tab === "existing"
        ? getSelectedSheetMemberPayload()
        : {
            member: {
              name: formState.name,
              gradeOrAge: getBirthYear(birthDateValue),
              guardianPhone: formState.guardianPhone,
            },
            sheetMetadata: {
              schoolName: formState.schoolName,
              birthDate: birthDateValue,
              gender: formState.gender,
            },
          };

    if (!identityPayload) {
      showBlockingDialog(
        "이용자 선택이 필요해요",
        "이용자를 선택해 주세요.",
        "selectUserRequired",
      );
      return;
    }

    const completionSpeech = getCompletionSpeechMessage(
      identityPayload.member.name,
      resourceChoice,
    );

    submitInFlightRef.current = true;
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    startTransition(async () => {
      try {
        if (resourceChoice === "space") {
          await postMutation("registerSpaceVisit", {
            ...identityPayload,
            note: "공간이용",
          });
        } else {
          await postMutation("enqueueVisit", {
            ...identityPayload,
            resourceType: selectedResourceType,
            pricingRuleId: effectivePricingRuleId,
          });
        }

        const message =
          resourceChoice === "space"
            ? `${identityPayload.member.name.trim()}님, 접수 완료되었습니다. 자, 이제 재밌게 놀자~`
            : `${identityPayload.member.name.trim()}님, 접수 완료되었습니다. 결제하고 이용해야 해요. 데스크로 가서 선생님께 안내받아 주세요.`;

        setCompletion({
          kind: resourceChoice === "space" ? "space" : "paid",
          message,
        });
        void announceCompletion(completionSpeech);
        refresh();
        completionTimerRef.current = setTimeout(finishCompletion, 8000);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "접수 처리에 실패했습니다.";

        showBlockingDialog(
          "접수할 수 없어요",
          message,
          getBlockingAudioCue(message),
        );
      } finally {
        submitInFlightRef.current = false;
      }
    });
  };

  const chooseResource = (nextChoice: KioskResourceChoice) => {
    if (nextChoice === "space") {
      setResourceChoice("space");
      setPricingRuleId("");
      setTab("existing");
      setSelectedMemberId("");
      setSheetMembers([]);
      setQuery("");
      setHasSearchedMembers(false);
      setAttemptedNewMemberSubmit(false);
      setPrivacyAgreed(false);
      setNotice("");
      setPhoneHint("");
      setStep("existing-member");
      return;
    }

    setResourceChoice(nextChoice);
    setPricingRuleId("");
    setTab(null);
    setSelectedMemberId("");
    setQuery("");
    setHasSearchedMembers(false);
    setAttemptedNewMemberSubmit(false);
    setPrivacyAgreed(false);
    setNotice("");
    setPhoneHint("");
    setStep("pricing");
  };

  const choosePricingRule = (nextPricingRuleId: string) => {
    setPricingRuleId(nextPricingRuleId);
    setTab("existing");
    setSelectedMemberId("");
    setSheetMembers([]);
    setQuery("");
    setHasSearchedMembers(false);
    setAttemptedNewMemberSubmit(false);
    setPrivacyAgreed(false);
    setNotice("");
    setPhoneHint("");
    setStep("existing-member");
  };

  const goToConsentStep = () => {
    if (tab === "new") {
      setAttemptedNewMemberSubmit(true);

      if (hasNewMemberErrors) {
        setNotice("빨간 표시된 정보를 모두 입력해 주세요.");
        speakKioskMessage(
          "빨간 표시된 정보를 모두 입력해 주세요.",
          "requiredFieldsMissing",
        );
        return;
      }

      if (!isElementaryGradeOneOrOlderBirthYear(formState.birthYear)) {
        showBlockingDialog(
          "아직 이용할 수 없어요",
          "나놀다판은 초등학교 1학년부터 이용할 수 있어요.\n보호자와 함께 선생님께 문의해 주세요.",
          "underageBlocked",
        );
        return;
      }
    }

    if (!identityReady) {
      setNotice("이용자 정보를 먼저 선택하거나 입력해 주세요.");
      speakKioskMessage("이용자를 선택해 주세요.", "selectUserRequired");
      return;
    }

    setPrivacyAgreed(false);
    setBlockingDialog(null);
    setNotice("");
    setStep("consent");
  };

  const startNewMemberRegistration = () => {
    setTab("new");
    setSelectedMemberId("");
    setSheetMembers([]);
    setFormState({
      ...DEFAULT_FORM,
      name: getNewMemberNamePrefill(query),
    });
    setHasSearchedMembers(false);
    setAttemptedNewMemberSubmit(false);
    setNotice("");
    setPhoneHint("");
    setBlockingDialog(null);
    setStep("new-member");
    speakKioskMessage("처음 온 친구는 새로 등록해 주세요.", "newMemberIntro");
  };

  const updateBirthDatePart = (
    key: "birthYear" | "birthMonth" | "birthDay",
    value: string,
  ) => {
    setFormState((current) => {
      const next = { ...current, [key]: value };
      const validDays = getBirthDayOptions(next.birthYear, next.birthMonth);

      if (next.birthDay && !validDays.includes(next.birthDay)) {
        next.birthDay = validDays.at(-1) ?? "";
      }

      return next;
    });
    setNotice("");
  };

  const updateGuardianPhone = (value: string) => {
    const normalizedValue = normalizePhoneInput(value);

    setFormState((current) => ({
      ...current,
      guardianPhone: normalizedValue,
    }));
    setPhoneHint(value !== normalizedValue ? "숫자만 입력돼요" : "");
    setNotice("");
  };

  const kioskShell = (
    children: ReactNode,
    stepLabel: string,
    canGoBack = true,
  ) => (
    <div className="min-h-screen bg-[color:var(--background)] px-4 py-5 text-[color:var(--foreground)] sm:px-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="flex min-h-10 items-center justify-between gap-3">
          {canGoBack ? (
            <button
              type="button"
              onClick={goBack}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--line)] bg-white px-3 py-2 text-[13px] font-semibold text-[color:var(--foreground)] shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowLeft className="size-4" />
              뒤로
            </button>
          ) : (
            <div />
          )}
          <div className="rounded-full bg-[color:var(--surface)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--muted)]">
            {stepLabel}
          </div>
        </header>
        {children}
        {notice ? (
          <div className="rounded-full border border-[color:var(--line)] bg-[color:var(--surface)] px-4 py-3 text-center text-sm text-[color:var(--foreground)]">
            {notice}
          </div>
        ) : null}
        {blockingDialog ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-[#111827]/35 px-5">
            <div className="w-full max-w-md rounded-[28px] border border-[color:var(--line)] bg-white p-7 text-center shadow-[0_24px_80px_rgba(15,23,42,0.22)]">
              <h2 className="text-[26px] font-black tracking-tight text-[color:var(--foreground)]">
                {blockingDialog.title}
              </h2>
              <p className="mt-4 whitespace-pre-line text-[18px] font-bold leading-8 text-[color:var(--foreground)]">
                {blockingDialog.message}
              </p>
              <button
                type="button"
                onClick={() => setBlockingDialog(null)}
                className="mt-7 inline-flex w-full items-center justify-center rounded-full border border-[color:var(--line)] bg-[color:var(--surface)] px-5 py-4 text-[16px] font-bold text-[color:var(--foreground)]"
              >
                확인
              </button>
            </div>
          </div>
        ) : null}
        {completion ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-[#111827]/45 px-5">
            <div className="w-full max-w-md rounded-[28px] bg-white p-7 text-center shadow-[0_24px_80px_rgba(15,23,42,0.28)]">
              <h2 className="text-[30px] font-black tracking-tight text-[color:var(--foreground)]">
                접수 완료!
              </h2>
              <p className="mt-3 text-[20px] font-bold leading-8 text-[color:var(--foreground)]">
                {completion.message}
              </p>
              <button
                type="button"
                onClick={finishCompletion}
                className="mt-7 inline-flex w-full items-center justify-center rounded-full bg-[color:var(--accent)] px-5 py-4 text-[16px] font-bold text-white"
              >
                확인
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  const entryScreen = (
    <section className="grid min-h-[80vh] items-center">
      <div className="surface-card relative rounded-[24px] p-6 sm:p-8">
        <Image
          src="/nanoldapan-logo.png"
          alt="나놀다판"
          width={1536}
          height={1024}
          priority
          className="absolute left-5 top-0 z-10 h-20 w-auto -translate-y-1/2 object-contain sm:left-6 sm:h-24"
        />
        <h2 className="text-[30px] font-black tracking-tight text-[color:var(--foreground)] sm:text-4xl">
          이용 종류를 고르세요
        </h2>
        <div className="mt-7 grid items-stretch gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <fieldset className="flex h-full flex-col rounded-[18px] border border-[color:var(--line)] px-4 pb-5 pt-3 sm:px-5">
            <legend className="px-3 text-[13px] font-black tracking-[0.22em] text-[color:var(--accent)]">
              유료
            </legend>
            <div className="grid flex-1 gap-4 md:grid-cols-3">
              {(["pc", "nintendo", "playstation"] as const).map((type) => (
                <ResourceCard
                  key={type}
                  label={
                    type === "playstation" ? "플스" : RESOURCE_TYPE_LABELS[type]
                  }
                  shortLabel={RESOURCE_TYPE_SHORT_LABELS[type]}
                  icon={type === "pc" ? Monitor : Gamepad2}
                  theme={RESOURCE_CARD_THEME[type]}
                  selected={resourceChoice === type}
                  free={resourceSummaries[type].free}
                  waiting={resourceSummaries[type].waiting}
                  showCounts={false}
                  onClick={() => chooseResource(type)}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="flex h-full flex-col rounded-[18px] border border-[color:var(--line)] px-4 pb-5 pt-3 sm:px-5">
            <legend className="px-3 text-[13px] font-black tracking-[0.22em] text-[color:var(--muted)]">
              무료
            </legend>
            <ResourceCard
              label="공간 이용"
              shortLabel="SPACE"
              icon={Users}
              theme={{
                background: "bg-[#f2f4f6]",
                text: "text-[#4e5968]",
                pill: "bg-white text-[#4e5968]",
              }}
              selected={resourceChoice === "space"}
              free={0}
              waiting={0}
              showCounts={false}
              onClick={() => chooseResource("space")}
            />
          </fieldset>
        </div>
      </div>
    </section>
  );

  const existingMemberScreen = (
    <section className="grid min-h-[80vh] items-center">
      <div className="surface-card mx-auto flex h-[calc(100vh-7rem)] max-h-[720px] w-full max-w-3xl flex-col rounded-[24px] p-6 sm:p-8">
        <h2 className="text-[26px] font-bold tracking-tight text-[color:var(--foreground)] sm:text-[30px]">
          이용자를
          <br />
          찾아주세요
        </h2>
        <label className="mt-6 block text-[16px] font-semibold text-[color:var(--foreground)]">
          이름 또는 연락처
        </label>
        <div className="relative mt-2 flex items-center gap-3 border-b-2 border-[color:var(--line)] px-1 py-1">
          <Search className="size-5 shrink-0 text-[color:var(--muted)]" />
          <input
            ref={searchInputRef}
            type="search"
            autoFocus
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              memberSearchRequestSeqRef.current += 1;
              setIsMemberSearchLoading(false);
              setQuery(event.target.value);
              setSelectedMemberId("");
              setSheetMembers([]);
              setHasSearchedMembers(false);
              setNotice("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void searchSheetMembers();
              }
            }}
            placeholder="예: 김하늘"
            className="toss-input min-w-0 flex-1 border-0 py-3 text-[16px]"
          />
          <button
            type="button"
            onClick={() => void searchSheetMembers()}
            disabled={isMemberSearchLoading}
            aria-busy={isMemberSearchLoading}
            className="inline-flex min-h-12 min-w-20 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] px-5 py-3 text-[15px] font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-45"
          >
            검색
          </button>
        </div>
        <div
          ref={searchResultsRef}
          className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
        >
          {visibleMembers.map((member) => (
            <MemberButton
              key={member.id}
              name={member.name}
              gradeOrAge={member.gradeOrAge}
              guardianPhone={member.guardianPhone}
              isSelected={selectedMemberId === member.id}
              onSelect={() => {
                setSelectedMemberId(member.id);
                setNotice("");
              }}
            />
          ))}
        </div>
        <div
          className={`mt-4 grid shrink-0 gap-3 ${
            showNewMemberRegistrationChoice
              ? "grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
              : "grid-cols-1"
          }`}
        >
          {showNewMemberRegistrationChoice ? (
            <button
              type="button"
              onClick={startNewMemberRegistration}
              className="inline-flex min-h-16 items-center justify-center rounded-full border border-[color:var(--line)] bg-white px-4 py-3 text-[16px] font-bold text-[color:var(--foreground)] transition hover:bg-[color:var(--surface)]"
            >
              새로 등록
            </button>
          ) : null}
          <button
            type="button"
            onClick={goToConsentStep}
            disabled={isPending || !selectedMember}
            className="inline-flex min-h-16 w-full items-center justify-center rounded-full bg-[color:var(--accent)] px-5 py-3 text-[17px] font-black text-white transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:bg-[color:var(--surface-soft)] disabled:text-[color:var(--muted)] disabled:opacity-100"
          >
            {selectedMember ? "선택 완료 · 다음" : "먼저 선택해 주세요"}
          </button>
        </div>
      </div>
    </section>
  );

  const newMemberScreen = (
    <section className="grid min-h-[80vh] items-center">
      <div className="surface-card mx-auto w-full max-w-3xl rounded-[24px] p-6 sm:p-8">
        <h2 className="text-[26px] font-bold tracking-tight text-[color:var(--foreground)] sm:text-[30px]">
          정보를
          <br />
          입력해 주세요
        </h2>
        <div className="relative mt-6 grid gap-4">
          <label className="block text-[16px] font-semibold text-[color:var(--foreground)]">
            학생 이름
          </label>
          <input
            value={formState.name}
            onChange={(event) =>
              setFormState((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
            className={getInputClassName(missingNewMemberFields.name)}
            placeholder="예: 김하늘"
          />
          {showNewMemberErrors && missingNewMemberFields.name
            ? errorText("학생 이름을 입력해 주세요.")
            : null}

          <label className="block text-[16px] font-semibold text-[color:var(--foreground)]">
            학교명
          </label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {POPULAR_SCHOOLS.map((school) => (
              <button
                key={school}
                type="button"
                onClick={() => {
                  setFormState((current) => ({
                    ...current,
                    schoolName: school,
                  }));
                  setNotice("");
                }}
                className={`rounded-[18px] border px-4 py-4 text-[16px] font-bold transition ${
                  formState.schoolName === school
                    ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
                    : showNewMemberErrors && missingNewMemberFields.schoolName
                      ? "border-red-400 bg-red-50 text-red-700"
                      : "border-[color:var(--line)] bg-[color:var(--surface)] text-[color:var(--foreground)]"
                }`}
              >
                {school}
              </button>
            ))}
          </div>
          <input
            value={formState.schoolName}
            onChange={(event) => {
              setFormState((current) => ({
                ...current,
                schoolName: event.target.value,
              }));
              setNotice("");
            }}
            className={getInputClassName(missingNewMemberFields.schoolName)}
            placeholder="다른 학교는 직접 입력 예: 놀다초"
          />
          {showNewMemberErrors && missingNewMemberFields.schoolName
            ? errorText("학교명을 선택하거나 입력해 주세요.")
            : null}

          <label className="block text-[16px] font-semibold text-[color:var(--foreground)]">
            생년월일
          </label>
          <div className="grid grid-cols-3 gap-3">
            <select
              value={formState.birthYear}
              onChange={(event) =>
                updateBirthDatePart("birthYear", event.target.value)
              }
              className={getInputClassName(
                missingNewMemberFields.birthDate,
                "min-h-[58px] text-[17px] font-semibold",
              )}
            >
              <option value="">연도</option>
              {BIRTH_YEAR_OPTIONS.map((year) => (
                <option key={year} value={year}>
                  {year}년
                </option>
              ))}
            </select>
            <select
              value={formState.birthMonth}
              onChange={(event) =>
                updateBirthDatePart("birthMonth", event.target.value)
              }
              className={getInputClassName(
                missingNewMemberFields.birthDate,
                "min-h-[58px] text-[17px] font-semibold",
              )}
            >
              <option value="">월</option>
              {BIRTH_MONTH_OPTIONS.map((month) => (
                <option key={month} value={month}>
                  {Number(month)}월
                </option>
              ))}
            </select>
            <select
              value={formState.birthDay}
              onChange={(event) =>
                updateBirthDatePart("birthDay", event.target.value)
              }
              className={getInputClassName(
                missingNewMemberFields.birthDate,
                "min-h-[58px] text-[17px] font-semibold",
              )}
            >
              <option value="">일</option>
              {birthDayOptions.map((day) => (
                <option key={day} value={day}>
                  {Number(day)}일
                </option>
              ))}
            </select>
          </div>
          {showNewMemberErrors && missingNewMemberFields.birthDate
            ? errorText("생년월일을 모두 선택해 주세요.")
            : null}

          <label className="block text-[16px] font-semibold text-[color:var(--foreground)]">
            성별
          </label>
          <div className="grid grid-cols-2 gap-3">
            {[
              ["male", "남"],
              ["female", "여"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setFormState((current) => ({
                    ...current,
                    gender: value as MemberFormState["gender"],
                  }));
                  setNotice("");
                }}
                className={`rounded-[18px] border px-5 py-4 text-[17px] font-bold transition ${
                  formState.gender === value
                    ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
                    : showNewMemberErrors && missingNewMemberFields.gender
                      ? "border-red-400 bg-red-50 text-red-700"
                      : "border-[color:var(--line)] bg-[color:var(--surface)] text-[color:var(--foreground)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {showNewMemberErrors && missingNewMemberFields.gender
            ? errorText("성별을 선택해 주세요.")
            : null}

          <label className="block text-[16px] font-semibold text-[color:var(--foreground)]">
            보호자 연락처
          </label>
          <input
            value={formState.guardianPhone}
            onChange={(event) => updateGuardianPhone(event.target.value)}
            inputMode="numeric"
            className={getInputClassName(missingNewMemberFields.guardianPhone)}
            placeholder="예: 01012345678"
          />
          {phoneHint ? (
            <p className="mt-1 text-sm font-semibold text-[color:var(--muted)]">
              {phoneHint}
            </p>
          ) : null}
          {showNewMemberErrors && missingNewMemberFields.guardianPhone
            ? errorText("보호자 연락처를 입력해 주세요.")
            : null}
        </div>
        <button
          type="button"
          onClick={goToConsentStep}
          disabled={isPending}
          className="mt-7 inline-flex w-full items-center justify-center rounded-full bg-[color:var(--accent)] px-5 py-4 text-[15px] font-semibold text-white transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          다음
        </button>
      </div>
    </section>
  );

  const consentScreen = (
    <section className="grid min-h-[80vh] items-center">
      <div className="surface-card mx-auto w-full max-w-3xl rounded-[24px] p-6 sm:p-8">
        <h2 className="text-[26px] font-bold tracking-tight text-[color:var(--foreground)] sm:text-[30px]">
          개인정보 수집 동의
        </h2>
        <div className="mt-6 space-y-4 rounded-[20px] border border-[color:var(--line)] bg-[color:var(--surface)] p-5">
          <div className="text-[15px] font-semibold text-[color:var(--foreground)]">
            개인정보 수집 및 이용 안내
          </div>
          <div className="space-y-3 text-[15px] font-semibold leading-7 text-[color:var(--foreground)]">
            <p>
              <strong>수집항목</strong>: 학생 이름, 학교명, 생년월일, 성별,
              보호자 연락처, 이용 항목과 접수·이용 기록
            </p>
            <p>
              <strong>이용목적</strong>: 나놀다판 이용 접수, 현장 운영과 안전
              확인, 노원청소년센터 행사 홍보 및 만족도 조사 문자 발송
            </p>
            <p>
              <strong>보유·이용기간</strong>: 운영 및 내부 관리 목적 달성 후
              센터 기준에 따라 보관·파기합니다.
            </p>
            <p>
              <strong>동의 거부 안내</strong>: 개인정보 수집·이용에 동의하지
              않을 수 있으며, 이 경우 키오스크 접수가 제한될 수 있어 선생님께
              문의해 주세요.
            </p>
          </div>
        </div>
        <label className="relative mt-5 flex items-start gap-3 rounded-[18px] border border-[color:var(--line)] bg-white p-5">
          <input
            type="checkbox"
            checked={privacyAgreed}
            onChange={(event) => {
              setPrivacyAgreed(event.target.checked);
              setNotice("");
            }}
            className="mt-1 size-5 accent-[color:var(--accent)]"
          />
          <span className="text-[16px] font-semibold leading-7 text-[color:var(--foreground)]">
            위 개인정보 수집 및 이용 안내를 확인했고 동의합니다.
          </span>
        </label>
        <button
          type="button"
          onClick={submitVisit}
          disabled={!canSubmit || isPending}
          className="mt-7 inline-flex w-full items-center justify-center rounded-full bg-[color:var(--accent)] px-5 py-4 text-[15px] font-semibold text-white transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isPending ? "접수 중..." : "동의하고 접수하기"}
        </button>
      </div>
    </section>
  );

  const pricingScreen = selectedResourceType ? (
    <section className="grid min-h-[80vh] items-center">
      <div className="surface-card mx-auto w-full max-w-3xl rounded-[24px] p-6 sm:p-8">
        <h2 className="text-4xl font-black tracking-tight text-[color:var(--foreground)]">
          시간을 고르세요
        </h2>
        <div className="relative mt-6 grid gap-3">
          {pricingRules.map((rule) => (
            <TimeButton
              key={rule.id}
              label={formatMinutes(rule.minutes)}
              selected={effectivePricingRuleId === rule.id}
              onClick={() => choosePricingRule(rule.id)}
            />
          ))}
        </div>
      </div>
    </section>
  ) : null;

  if (step === "entry") {
    return kioskShell(entryScreen, "이용 선택", false);
  }

  if (step === "pricing") {
    return kioskShell(pricingScreen, "시간 선택");
  }

  if (step === "existing-member") {
    return kioskShell(existingMemberScreen, "사용자 확인");
  }

  if (step === "new-member") {
    return kioskShell(newMemberScreen, "새 등록");
  }

  return kioskShell(consentScreen, "동의");
}
