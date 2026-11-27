import { createContext, useContext } from "react";
import { FlatList, ScrollView, type FlatListProps, type ScrollViewProps } from "react-native";
import { FlatList as HostFlatList, ScrollView as HostScrollView } from "@getpaseo/plugin/client/ui";

export const IsolatedReader = createContext(false);

export function ReaderScrollView(props: ScrollViewProps) {
  const Scroll = useContext(IsolatedReader) ? ScrollView : HostScrollView;
  return <Scroll {...props} />;
}

export function ReaderFlatList<Item>(props: FlatListProps<Item>) {
  if (useContext(IsolatedReader)) return <FlatList {...props} />;
  return <HostFlatList {...props} />;
}
