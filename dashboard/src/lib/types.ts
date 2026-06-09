export type MealType = "breakfast" | "lunch" | "dinner" | "snack";
export type FeedbackSentiment = "good" | "neutral" | "bad";

export type Meal = {
  id: string;
  text: string;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  meal_type?: MealType;
  logged_at: string;
  feedback_sentiment?: FeedbackSentiment;
  feedback_note?: string;
};

export type DayTotals = {
  date: string; // YYYY-MM-DD
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  meal_count: number;
};

export type UserProfile = {
  name?: string;
  age?: number;
  sex?: "male" | "female" | "other";
  height_cm?: number;
  weight_kg?: number;
  activity_level?:
    | "sedentary"
    | "light"
    | "moderate"
    | "active"
    | "very_active";
  daily_kcal_goal?: number;
  dietary_preferences?: string[];
  allergies?: string[];
  likes?: string[];
  dislikes?: string[];
  onboarded_at?: string;
};

export type Assumption = {
  id: string;
  text: string;
  confidence: "low" | "medium" | "high";
  status: "active" | "confirmed" | "rejected";
  noted_at: string;
};

export const MEAL_TYPE_ORDER: MealType[] = [
  "breakfast",
  "snack",
  "lunch",
  "dinner",
];

export const MEAL_TYPE_LABEL: Record<MealType, string> = {
  breakfast: "Breakfast",
  snack: "Snack",
  lunch: "Lunch",
  dinner: "Dinner",
};
