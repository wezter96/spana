import FontAwesome from "@expo/vector-icons/FontAwesome";
import type { ColorValue } from "react-native";

export const TabBarIcon = ({
  color,
  ...props
}: {
  name: React.ComponentProps<typeof FontAwesome>["name"];
  color: ColorValue;
}) => {
  return <FontAwesome size={24} style={{ color, marginBottom: -3 }} {...props} />;
};
